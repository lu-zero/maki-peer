import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { Spool } from "./shared/spool.ts"
import { runtimeDir, spoolRootFromEnv } from "./paths.ts"
import { listStates, pidAlive, publish, removeState, unpublish } from "./state.ts"

const EMPTY_EXIT_MS = 30_000
const REFRESH_MS = 2000
const HEARTBEAT_STALE_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeHeartbeat(path: string): void {
  try {
    writeFileSync(path, String(Date.now()))
  } catch {
    /* the next refresh writes it again */
  }
}

function heartbeatFresh(path: string): boolean {
  try {
    const at = Number(readFileSync(path, "utf8"))
    return Number.isFinite(at) && Date.now() - at < HEARTBEAT_STALE_MS
  } catch {
    return false
  }
}

/**
 * The lock names its holder, which refreshes a heartbeat beside it. A pid can
 * outlive the daemon that owned it, so the heartbeat is what says the holder is
 * still running. It also closes the window between creating the lock and
 * writing the pid.
 */
async function acquireLock(lock: string, heartbeat: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      let written = 0
      try {
        written = Number(readFileSync(lock, "utf8"))
      } catch {
        written = 0
      }
      if (written !== process.pid) {
        await sleep(20)
        continue
      }
      writeHeartbeat(heartbeat)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let holder = 0
      try {
        holder = Number(readFileSync(lock, "utf8"))
      } catch {
        holder = 0
      }
      if (pidAlive(holder) && heartbeatFresh(heartbeat)) return false
      try {
        unlinkSync(lock)
      } catch {
        /* the owner removed it between the read and the unlink */
      }
      try {
        unlinkSync(heartbeat)
      } catch {
        /* a missing heartbeat is already stale */
      }
      await sleep(20)
    }
  }
  return false
}

function releaseLock(lock: string, heartbeat: string): void {
  try {
    if (Number(readFileSync(lock, "utf8")) !== process.pid) return
    unlinkSync(lock)
  } catch {
    /* a lock we no longer hold is the next start's problem */
  }
  try {
    unlinkSync(heartbeat)
  } catch {
    /* a missing heartbeat is harmless */
  }
}

/** Refresh every live session, and drop a record whose Claude process is gone. */
export async function refreshAll(spoolRoot: string, runtime: string): Promise<number> {
  const spool = new Spool(spoolRoot)
  await spool.prepare()
  let live = 0
  for (const state of await listStates(runtime)) {
    if (!pidAlive(state.claudePid)) {
      await unpublish(spool, state.sessionId)
      await removeState(runtime, state.sessionId)
      continue
    }
    live++
    await publish(spool, state).catch(() => {})
  }
  return live
}

async function main(): Promise<void> {
  const spoolRoot = spoolRootFromEnv()
  const runtime = runtimeDir(spoolRoot)
  await mkdir(runtime, { recursive: true })
  const lock = join(runtime, "daemon.lock")
  const heartbeat = join(runtime, "daemon.heartbeat")
  if (!(await acquireLock(lock, heartbeat))) process.exit(0)

  let emptySince = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let refreshing = Promise.resolve()
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    releaseLock(lock, heartbeat)
    process.exit(0)
  }

  timer = setInterval(() => {
    refreshing = refreshing.then(async () => {
      writeHeartbeat(heartbeat)
      const live = await refreshAll(spoolRoot, runtime)
      if (live > 0) {
        emptySince = 0
        return
      }
      if (emptySince === 0) emptySince = Date.now()
      if (Date.now() - emptySince >= EMPTY_EXIT_MS) stop()
    })
  }, REFRESH_MS)

  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}

if (import.meta.main) {
  await main()
}
