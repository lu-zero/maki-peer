import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"

import { encodeMessage } from "../src/frame.ts"
import { channelEvent, capabilities, serve } from "../src/mcp.ts"
import { runtimeDir, spoolRootFromEnv } from "../src/paths.ts"
import { refreshAll } from "../src/daemon.ts"
import { messageRecord } from "../src/shared/peer.ts"
import { parseOwner } from "../src/shared/protocol.ts"
import { Spool } from "../src/shared/spool.ts"
import { handleEvent } from "../src/handle.ts"
import { peerIdOf, saveState, type SessionState } from "../src/state.ts"
import { callTool } from "../src/tools.ts"

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maki-peer-claude-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function layout(root: string) {
  const spoolRoot = join(root, "peers")
  const env = { ...process.env, HOME: root, MAKI_PEER_SPOOL: spoolRoot }
  return { spoolRoot, runtime: runtimeDir(spoolRoot) }
}

const session = "ses_claude_one"
const pid = process.pid

async function emit(box: ReturnType<typeof layout>, event: Record<string, unknown>) {
  return handleEvent({
    event,
    claudePid: pid,
    spoolRoot: box.spoolRoot,
    runtime: box.runtime,
  })
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

async function writeMail(box: ReturnType<typeof layout>, body = "hello") {
  const spool = new Spool(box.spoolRoot)
  await spool.prepare()
  const id = "m-foreign"
  await spool.write(join(spool.inboxPath(peerIdOf(session)), `${id}.json`), messageRecord({
    id,
    from: "mk-aaaaaaaa",
    fromName: "maki-aaaaaaaa",
    to: peerIdOf(session),
    body,
    kind: "observation",
    host: "maki",
  }))
  return spool
}

function collector(): { output: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: Buffer[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  return {
    output,
    lines: () => Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

async function* input(...messages: unknown[]): AsyncGenerator<Buffer> {
  for (const message of messages) yield encodeMessage(message)
}

describe("runtime directory", () => {
  test("follows the spool, including the ~/.maki takeover", () => {
    const home = tempRoot()
    expect(runtimeDir(spoolRootFromEnv({ HOME: home }))).toBe(join(home, ".local/state/maki/claude-peer"))
    mkdirSync(join(home, ".maki"))
    expect(runtimeDir(spoolRootFromEnv({ HOME: home }))).toBe(join(home, ".maki/claude-peer"))
  })

  test("the hook script resolves the same directory", async () => {
    const home = tempRoot()
    const script = join(import.meta.dir, "../bin/hook")
    const xdg = await Bun.$`sh ${script} --runtime-dir`.env({ ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg") }).text()
    expect(xdg.trim()).toBe(runtimeDir(spoolRootFromEnv({ HOME: home, XDG_STATE_HOME: join(home, "xdg") })))
    mkdirSync(join(home, ".maki"))
    const taken = await Bun.$`sh ${script} --runtime-dir`.env({ ...process.env, HOME: home }).text()
    expect(taken.trim()).toBe(join(home, ".maki/claude-peer"))
  })
})

describe("presence", () => {
  test("a session start publishes a claude record and an end keeps the inbox", async () => {
    const box = layout(tempRoot())
    await emit(box, { hook_event_name: "SessionStart", session_id: session, cwd: "/work" })
    const spool = new Spool(box.spoolRoot)
    const owner = parseOwner(read(spool.ownerPath(peerIdOf(session))))
    expect(owner?.origin?.host).toBe("claude")
    expect(owner?.id.startsWith("cc-")).toBe(true)
    expect(owner?.name.startsWith("claude-")).toBe(true)
    expect(owner?.cwd).toBe("/work")
    expect(owner?.session_id).toBe(session)

    await spool.ensureInbox(peerIdOf(session))
    await emit(box, { hook_event_name: "SessionEnd", session_id: session })
    expect(existsSync(spool.ownerPath(peerIdOf(session)))).toBe(false)
    expect(existsSync(spool.inboxPath(peerIdOf(session)))).toBe(true)
  })

  test("the daemon drops a session whose process is gone", async () => {
    const box = layout(tempRoot())
    const dead: SessionState = {
      sessionId: "ses_dead",
      claudePid: 2147483647,
      busy: false,
      waiting: false,
      started: 0,
    }
    await saveState(box.runtime, dead)
    const spool = new Spool(box.spoolRoot)
    await spool.prepare()
    await emit(box, { hook_event_name: "SessionStart", session_id: session, cwd: "/work" })
    expect(await refreshAll(box.spoolRoot, box.runtime)).toBe(1)
    expect(existsSync(join(box.runtime, "sessions", "ses_dead.json"))).toBe(false)
  })
})

describe("delivery", () => {
  test("a tool result carries the note in Claude's hook shape", async () => {
    const box = layout(tempRoot())
    await emit(box, { hook_event_name: "SessionStart", session_id: session, cwd: "/work" })
    await writeMail(box)
    const reply = await emit(box, { hook_event_name: "PostToolUse", session_id: session })
    const parsed = JSON.parse(reply) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[peer maki-aaaaaaaa mk-aaaaaaaa] hello")
  })

  test("a channel claims idle mail, so a later hook has nothing to print", async () => {
    const box = layout(tempRoot())
    await emit(box, { hook_event_name: "SessionStart", session_id: session, cwd: "/work" })
    await writeMail(box)

    const sink = collector()
    process.env.MAKI_PEER_SPOOL = box.spoolRoot
    try {
      await channelEvent(sink.output, { pid })
    } finally {
      delete process.env.MAKI_PEER_SPOOL
    }
    const event = sink.lines()[0]
    expect(event.method).toBe("notifications/claude/channel")
    const params = event.params as { content: string; meta: Record<string, string> }
    expect(params.content).toContain("[peer maki-aaaaaaaa mk-aaaaaaaa] hello")
    expect(params.meta.origin_host).toBe("maki")
    expect(params.meta.peer_id).toBe("mk-aaaaaaaa")

    const reply = await emit(box, { hook_event_name: "PostToolUse", session_id: session })
    expect(reply).toBe("")
  })
})

describe("tools", () => {
  test("list, cwd, send and broadcast use the shared protocol", async () => {
    const box = layout(tempRoot())
    await emit(box, { hook_event_name: "SessionStart", session_id: session, cwd: "/work" })
    const hint = { pid }
    const listed = await callTool(new Spool(box.spoolRoot), box.runtime, hint, "peer_list", {})
    expect(listed.text).toContain("(you)")
    expect(listed.text).toContain("via claude")
    expect(listed.text).toContain("/work")

    const cwd = await callTool(new Spool(box.spoolRoot), box.runtime, hint, "peer_cwd", {})
    expect(JSON.parse(cwd.text)[peerIdOf(session)]).toBe("/work")

    const spool = new Spool(box.spoolRoot)
    await spool.prepare()
    await spool.write(spool.ownerPath("mk-target"), {
      protocol: 1,
      id: "mk-target",
      name: "maki-target",
      started: 0,
      last_seen: Math.floor(Date.now() / 1000),
      status: "idle",
      cwd: "/work",
      origin: { host: "maki" },
    })
    const sent = await callTool(spool, box.runtime, hint, "peer_send", { peer_id: "maki-target", message: "find" })
    expect(sent.error).toBe(false)
    const inbox = readdirSync(spool.inboxPath("mk-target")).filter((name) => name.endsWith(".json"))
    expect(inbox.length).toBe(1)
    expect(read(join(spool.inboxPath("mk-target"), inbox[0] ?? "")).origin).toEqual({ host: "claude" })
  })
})

describe("mcp server", () => {
  test("initialize declares the channel capability only when enabled", () => {
    expect(capabilities(false)).toEqual({ tools: { listChanged: false } })
    expect(capabilities(true)).toEqual({
      tools: { listChanged: false },
      experimental: { "claude/channel": {} },
    })
  })

  test("tools/list and tools/call answer over stdio", async () => {
    const box = layout(tempRoot())
    process.env.MAKI_PEER_SPOOL = box.spoolRoot
    await emit(box, { hook_event_name: "SessionStart", session_id: session, cwd: "/work" })
    const sink = collector()
    await serve(input(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "peer_cwd", arguments: {} } },
    ), sink.output, { channel: false })
    const replies = sink.lines()
    expect(replies.length).toBe(3)
    expect((replies[0]?.result as { capabilities: Record<string, unknown> }).capabilities).toEqual({ tools: { listChanged: false } })
    expect(((replies[1]?.result as { tools: unknown[] }).tools).length).toBe(4)
    expect(((replies[2]?.result as { content: { text: string }[] }).content[0]?.text)).toContain(peerIdOf(session))
    delete process.env.MAKI_PEER_SPOOL
  })
})

describe("vendored spool", () => {
  test("matches the opencode sources", () => {
    for (const name of ["spool.ts", "peer.ts", "protocol.ts", "receive.ts"]) {
      const here = readFileSync(join(import.meta.dir, "../src/shared", name), "utf8")
      const there = readFileSync(join(import.meta.dir, "../../opencode/src", name), "utf8")
      expect(here).toBe(there)
    }
  })
})
