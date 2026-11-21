import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { Spool } from "./shared/spool.ts"
import { runtimeDir, spoolRootFromEnv } from "./paths.ts"
import { listStates, pidAlive, publish, removeState, unpublish } from "./state.ts"

const EMPTY_EXIT_MS = 30_000
const REFRESH_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The lock holds its own pid, so a crashed holder can be told from a live one. */
async function acquireLock(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let holder = 0
      try {
        holder = Number(readFileSync(path, "utf8"))
      } catch {
        holder = 0
      }
      if (pidAlive(holder)) return false
      try {
        unlinkSync(path)
      } catch {
        /* the owner removed it between the read and the unlink */
      }
      await sleep(20)
    }
  }
  return false
}

function releaseLock(path: string): void {
  try {
    if (Number(readFileSync(path, "utf8")) !== process.pid) return
    unlinkSync(path)
  } catch {
    /* a lock we no longer hold is the next start's problem */
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
  if (!(await acquireLock(lock))) process.exit(0)

  let emptySince = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let refreshing = Promise.resolve()
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    releaseLock(lock)
    process.exit(0)
  }

  timer = setInterval(() => {
    refreshing = refreshing.then(async () => {
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
