import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { DETAIL_REFRESH_SECONDS } from "./shared/protocol.ts"
import { Spool } from "./shared/spool.ts"
import { handleEvent } from "./handle.ts"
import { runtimeDir, spoolRootFromEnv } from "./paths.ts"
import { listStates, pidAlive, publish, removeState, saveState, unpublish } from "./state.ts"
import { readSummary } from "./summary.ts"

const EMPTY_EXIT_MS = 30_000
const REFRESH_MS = 2000

let gate: Promise<void> = Promise.resolve()

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn)
  gate = run.then(
    () => {},
    () => {},
  )
  return run
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One daemon per user. The lock file's contents are the holder's pid, written
 * in the same call that creates it, so a second start can tell a live holder
 * from a crashed one.
 */
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

/** Refresh every live session, and drop a record whose grok process is gone. */
export async function refreshAll(spoolRoot: string, runtime: string): Promise<number> {
  const spool = new Spool(spoolRoot)
  await spool.prepare()
  const now = Date.now()
  let live = 0
  for (const state of await listStates(runtime)) {
    if (!pidAlive(state.grokPid)) {
      await unpublish(spool, state.sessionId)
      await removeState(runtime, state.sessionId)
      continue
    }
    live++
    let next = state
    if (now - state.detailChecked >= DETAIL_REFRESH_SECONDS * 1000) {
      try {
        const detail = readSummary(state.sessionId, state.cwd)
        next = {
          ...state,
          ...(detail.title ? { title: detail.title } : {}),
          ...(detail.model ? { model: detail.model } : {}),
          detailChecked: now,
        }
        await saveState(runtime, next)
      } catch {
        /* the record keeps the detail it had */
      }
    }
    await publish(spool, next).catch(() => {})
  }
  return live
}

async function onRequest(req: Request, spoolRoot: string, runtime: string): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname !== "/hook") return new Response("not found", { status: 404 })
  if (req.method !== "POST") return new Response("method", { status: 405 })
  const pid = Number(req.headers.get("x-grok-pid"))
  let event: unknown
  try {
    event = await req.json()
  } catch {
    return new Response("bad json", { status: 400 })
  }
  const reply = await handleEvent({
    event,
    grokPid: Number.isInteger(pid) ? pid : 0,
    spoolRoot,
    runtime,
  })
  if (!reply) return new Response(null, { status: 204 })
  return new Response(reply, { headers: { "content-type": "application/json" } })
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
  let server: ReturnType<typeof Bun.serve> | undefined
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    server?.stop(true)
    releaseLock(lock)
    try {
      unlinkSync(join(runtime, "daemon.port"))
    } catch {
      /* the port file is a hint, not the lock */
    }
    process.exit(0)
  }

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      try {
        return await exclusive(() => onRequest(req, spoolRoot, runtime))
      } catch (error) {
        console.error(`maki-peer: ${error instanceof Error ? error.message : String(error)}`)
        return new Response(null, { status: 500 })
      }
    },
  })
  await writeFile(join(runtime, "daemon.port"), String(server.port))

  timer = setInterval(() => {
    void exclusive(async () => {
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
