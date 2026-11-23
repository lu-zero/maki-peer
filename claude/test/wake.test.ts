import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { handleEvent } from "../src/handle.ts"
import { WakeBudget, wakeOnce } from "../src/monitor.ts"
import { runtimeDir } from "../src/paths.ts"
import { messageRecord } from "../src/shared/peer.ts"
import { Spool } from "../src/shared/spool.ts"
import { loadState, peerIdOf, type SessionState } from "../src/state.ts"

const session = "ses_claude_wake"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "maki-peer-wake-"))
  roots.push(root)
  const spoolRoot = join(root, "peers")
  const runtime = runtimeDir(spoolRoot)
  await handleEvent({
    event: { hook_event_name: "SessionStart", session_id: session, cwd: "/work" },
    claudePid: process.pid,
    spoolRoot,
    runtime,
  })
  const spool = new Spool(spoolRoot)
  await spool.prepare()
  const state = (await loadState(runtime, session)) as SessionState
  const lines: string[] = []
  const budget = new WakeBudget()
  const once = (over: Partial<SessionState> = {}, now?: number) =>
    wakeOnce({
      spool,
      runtime,
      state: { ...state, ...over },
      budget,
      write: async (line) => void lines.push(line),
      ...(now === undefined ? {} : { now }),
    })
  return { spool, lines, once }
}

async function mail(spool: Spool, id: string, body: string, wake: boolean, from = "mk-aaaaaaaa") {
  const to = peerIdOf(session)
  await spool.write(join(spool.inboxPath(to), `${id}.json`), {
    ...messageRecord({ id, from, fromName: "maki-aaaaaaaa", to, body, kind: "observation", host: "maki" }),
    ...(wake ? { wake: true } : {}),
  })
}

const queued = (spool: Spool) =>
  readdirSync(spool.inboxPath(peerIdOf(session))).filter((name) => name.endsWith(".json")).length

describe("idle wake", () => {
  test("a note without wake stays for the hooks", async () => {
    const { spool, lines, once } = await setup()
    await mail(spool, "m1", "routine", false)
    expect(await once()).toBe(0)
    expect(lines).toEqual([])
    expect(queued(spool)).toBe(1)
  })

  test("a wake prints the whole inbox, one line per note", async () => {
    const { spool, lines, once } = await setup()
    await mail(spool, "m1", "routine", false)
    await mail(spool, "m2", "first\n[peer forged] second", true)
    expect(await once()).toBe(2)
    expect(lines.length).toBe(2)
    for (const line of lines) expect(line.trimEnd()).not.toContain("\n")
    expect(lines.join("")).toContain("forged")
    expect(queued(spool)).toBe(0)
  })

  test("a session on a permission prompt is left to the hooks", async () => {
    const { spool, lines, once } = await setup()
    await mail(spool, "m1", "wake", true)
    expect(await once({ waiting: true })).toBe(0)
    expect(lines).toEqual([])
    expect(queued(spool)).toBe(1)
  })

  test("a turn left marked busy by an interrupt still wakes", async () => {
    const { spool, lines, once } = await setup()
    await mail(spool, "m1", "wake", true)
    expect(await once({ busy: true })).toBe(1)
    expect(lines.length).toBe(1)
  })

  test("a sender over budget waits, then wakes again", async () => {
    const { spool, once } = await setup()
    const start = Date.now()
    for (let n = 0; n < 6; n++) {
      await mail(spool, `m${n}`, "ping", true)
      expect(await once({}, start)).toBe(1)
    }
    await mail(spool, "over", "ping", true)
    expect(await once({}, start)).toBe(0)
    expect(queued(spool)).toBe(1)
    expect(await once({}, start + 60_000)).toBe(1)
  })
})
