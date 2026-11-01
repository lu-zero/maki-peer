import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { afterEach, describe, expect, test } from "bun:test"

import { takeMail } from "../src/deliver.ts"
import { encodeMessage, LineReader } from "../src/frame.ts"
import { sessionIdFromPluginData } from "../src/identity.ts"
import { handleHook } from "../src/hook.ts"
import { serve } from "../src/mcp.ts"
import { peerIdOf } from "../src/presence.ts"
import { messageRecord } from "../src/shared/peer.ts"
import { parseOwner } from "../src/shared/protocol.ts"
import { Spool } from "../src/shared/spool.ts"
import { loadState } from "../src/state.ts"
import { callTool } from "../src/tools.ts"

const roots: string[] = []

function layout(sessionId = "sess-1") {
  const root = mkdtempSync(join(tmpdir(), "vibe-peer-"))
  roots.push(root)
  const pluginData = join(root, "plugins", "data", sessionId, "maki-peer")
  const spoolRoot = join(root, "peers")
  return { root, sessionId, pluginData, spoolRoot, spool: new Spool(spoolRoot) }
}

function event(name: string, sessionId: string, cwd?: string) {
  return {
    hook_event_name: name,
    session_id: sessionId,
    transcript_path: "",
    ...(cwd ? { cwd } : {}),
    parent_session_id: null,
  }
}

async function ownerOf(spool: Spool, sessionId: string) {
  return parseOwner(await spool.read(spool.ownerPath(peerIdOf(sessionId))))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("session identity", () => {
  test("reads the session id from the per-session data directory", () => {
    const box = layout("Abc-9")
    expect(sessionIdFromPluginData(box.pluginData)).toBe("Abc-9")
    expect(sessionIdFromPluginData(join(box.root, "plugin-data", "maki-peer"))).toBeUndefined()
  })

  test("a hook for a different session does nothing", async () => {
    const box = layout()
    const reply = await handleHook(event("pre_tool", "other-session", "/work"), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })
    expect(reply).toBe("")
    expect(await ownerOf(box.spool, box.sessionId)).toBeUndefined()
  })
})

describe("presence", () => {
  test("pre_tool marks working and post_agent marks idle", async () => {
    const box = layout()
    expect(await handleHook(event("pre_tool", box.sessionId, "/work/app"), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })).toBe("")
    const working = await ownerOf(box.spool, box.sessionId)
    expect(working?.status).toBe("working")
    expect(working?.cwd).toBe("/work/app")
    expect(working?.origin?.host).toBe("vibe")
    expect(working?.id.startsWith("vb-")).toBe(true)

    expect(await handleHook(event("post_agent", box.sessionId, "/work/app"), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })).toBe("")
    expect((await ownerOf(box.spool, box.sessionId))?.status).toBe("idle")
  })

  test("the server publishes while it runs and removes the record when stdin closes", async () => {
    const box = layout()
    let release = () => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    let seen = false
    const input = (async function* () {
      yield encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })
      await opened
    })()
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const body = Buffer.from(chunk).toString("utf8")
        expect(body).toContain("maki-peer")
        const record = JSON.parse(readFileSync(box.spool.ownerPath(peerIdOf(box.sessionId)), "utf8")) as {
          origin?: { host?: string }
        }
        expect(record.origin?.host).toBe("vibe")
        seen = true
        release()
        callback()
      },
    })
    await serve(input, output, { spoolRoot: box.spoolRoot, pluginData: box.pluginData })
    expect(seen).toBe(true)
    expect(await ownerOf(box.spool, box.sessionId)).toBeUndefined()
  })
})

describe("delivery", () => {
  test("post_tool appends mail and post_agent leaves it queued", async () => {
    const box = layout()
    await handleHook(event("pre_tool", box.sessionId, "/work"), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })
    const peerId = peerIdOf(box.sessionId)
    const id = `${peerId}-note`
    await box.spool.ensureInbox(peerId)
    await box.spool.write(
      join(box.spool.inboxPath(peerId), `${id}.json`),
      messageRecord({
        id,
        from: "maki-aaaaaaaa",
        fromName: "maki-aaaaaaaa",
        to: peerId,
        body: "the build failed",
        kind: "observation",
        topic: "ci",
        host: "maki",
        session: "not-a-vibe-session",
      }),
    )

    const idle = await handleHook(event("post_agent", box.sessionId), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })
    expect(idle).toBe("")
    expect(await box.spool.read(join(box.spool.inboxPath(peerId), `${id}.json`))).toBeDefined()

    const reply = await handleHook(event("post_tool", box.sessionId), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })
    const parsed = JSON.parse(reply) as { hook_specific_output: { additional_context: string } }
    expect(parsed.hook_specific_output.additional_context).toBe(
      "[peer maki-aaaaaaaa maki-aaaaaaaa] ci: the build failed",
    )
    expect(await box.spool.read(join(box.spool.inboxPath(peerId), `${id}.json`))).toBeUndefined()
  })

  test("a vibe address for a session this process does not own is dropped", async () => {
    const box = layout()
    const peerId = peerIdOf(box.sessionId)
    const id = `${peerId}-gone`
    await box.spool.prepare()
    await box.spool.ensureInbox(peerId)
    await box.spool.write(
      join(box.spool.inboxPath(peerId), `${id}.json`),
      messageRecord({
        id,
        from: "vb-bbbbbbbbbbbbbbbb",
        fromName: "vibe-bbbbbbbb",
        to: peerId,
        body: "for somebody else",
        kind: "observation",
        host: "vibe",
        session: "other-session",
      }),
    )
    expect(await takeMail(box.spool, box.sessionId)).toBe("")
    expect(await box.spool.read(join(box.spool.inboxPath(peerId), `${id}.json`))).toBeUndefined()
  })

  test("a long delivery is cut", async () => {
    const box = layout()
    const peerId = peerIdOf(box.sessionId)
    const id = `${peerId}-long`
    await box.spool.prepare()
    await box.spool.ensureInbox(peerId)
    await box.spool.write(
      join(box.spool.inboxPath(peerId), `${id}.json`),
      messageRecord({
        id,
        from: "maki-aaaaaaaa",
        fromName: "maki-aaaaaaaa",
        to: peerId,
        body: "x".repeat(12000),
        kind: "observation",
        host: "maki",
      }),
    )
    const reply = await takeMail(box.spool, box.sessionId)
    const text = (JSON.parse(reply) as { hook_specific_output: { additional_context: string } }).hook_specific_output
      .additional_context
    expect(text.endsWith("\n[truncated]")).toBe(true)
    expect(text.length).toBeLessThan(9100)
  })
})

describe("tools", () => {
  test("lists this session and sends to one peer", async () => {
    const box = layout()
    const now = Math.floor(Date.now() / 1000)
    await box.spool.prepare()
    await box.spool.write(box.spool.ownerPath("maki-peerone"), {
      protocol: 1,
      id: "maki-peerone",
      name: "maki-peerone",
      started: now,
      last_seen: now,
      status: "idle",
      cwd: "/work/app",
    })
    await handleHook(event("pre_tool", box.sessionId, "/work/app"), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })

    const listed = await callTool(box.spool, box.pluginData, "peer_list", {})
    expect(listed.error).toBe(false)
    expect(listed.text).toContain("(you)")
    expect(listed.text).toContain("via vibe")
    expect(listed.text).toContain("via maki")

    const sent = await callTool(box.spool, box.pluginData, "peer_send", {
      peer_id: "maki-peerone",
      message: "look here",
      session: "ignored-on-maki",
      topic: "note",
    })
    expect(sent.error).toBe(false)
    const inbox = await box.spool.listJson(box.spool.inboxPath("maki-peerone"))
    expect(inbox.length).toBe(1)
    const message = (await box.spool.read(inbox[0] ?? "")) as { origin: { host: string }; session?: string; topic?: string }
    expect(message.origin.host).toBe("vibe")
    expect(message.session).toBeUndefined()
    expect(message.topic).toBe("note")

    const own = await callTool(box.spool, box.pluginData, "peer_send", {
      peer_id: peerIdOf(box.sessionId),
      message: "hello me",
    })
    expect(own.error).toBe(true)
  })

  test("a session field is kept for a vibe recipient", async () => {
    const box = layout()
    const other = layout("sess-2")
    await handleHook(event("post_agent", other.sessionId, "/elsewhere"), {
      spoolRoot: box.spoolRoot,
      pluginData: other.pluginData,
    })
    await handleHook(event("post_agent", box.sessionId, "/work"), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })
    const sent = await callTool(box.spool, box.pluginData, "peer_send", {
      peer_id: peerIdOf(other.sessionId),
      message: "for that session",
      session: other.sessionId,
    })
    expect(sent.error).toBe(false)
    const inbox = await box.spool.listJson(box.spool.inboxPath(peerIdOf(other.sessionId)))
    const message = (await box.spool.read(inbox[0] ?? "")) as { session?: string; origin: { host: string } }
    expect(message.origin.host).toBe("vibe")
    expect(message.session).toBe(other.sessionId)
  })

  test("same_dir_only waits until a hook has reported a directory", async () => {
    const box = layout()
    const early = await callTool(box.spool, box.pluginData, "peer_broadcast", {
      message: "hello",
      same_dir_only: true,
    })
    expect(early.error).toBe(true)
    expect(early.text).toContain("no directory")

    await handleHook(event("pre_tool", box.sessionId, "/work/app"), {
      spoolRoot: box.spoolRoot,
      pluginData: box.pluginData,
    })
    const now = Math.floor(Date.now() / 1000)
    await box.spool.write(box.spool.ownerPath("maki-same"), {
      protocol: 1,
      id: "maki-same",
      name: "maki-same",
      started: now,
      last_seen: now,
      status: "idle",
      cwd: "/work/app",
    })
    await box.spool.write(box.spool.ownerPath("maki-other"), {
      protocol: 1,
      id: "maki-other",
      name: "maki-other",
      started: now,
      last_seen: now,
      status: "idle",
      cwd: "/other",
    })
    const sent = await callTool(box.spool, box.pluginData, "peer_broadcast", {
      message: "team",
      same_dir_only: true,
    })
    expect(sent).toEqual({ text: "Queued 1 peer messages.", error: false })
  })

  test("a send without a session id fails", async () => {
    const box = layout()
    const result = await callTool(box.spool, join(box.root, "plugin-data", "maki-peer"), "peer_send", {
      peer_id: "maki-peerone",
      message: "no",
    })
    expect(result.error).toBe(true)
  })
})

describe("frames", () => {
  test("a newline frame round trips, including a split chunk", () => {
    const reader = new LineReader()
    const bytes = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" })
    reader.push(bytes.subarray(0, 12))
    expect(reader.drain()).toEqual([])
    reader.push(bytes.subarray(12))
    expect(reader.drain()).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }])
  })
})

describe("vendored spool", () => {
  test("matches the opencode sources, because install copies only this directory", () => {
    for (const name of ["spool.ts", "peer.ts", "protocol.ts", "receive.ts"]) {
      const here = readFileSync(join(import.meta.dir, "../src/shared", name), "utf8")
      const there = readFileSync(join(import.meta.dir, "../../opencode/src", name), "utf8")
      expect(here).toBe(there)
    }
  })
})

describe("hook script", () => {
  test("registers the session named by PLUGIN_DATA", async () => {
    const box = layout()
    const env = {
      ...process.env,
      HOME: box.root,
      MAKI_PEER_SPOOL: box.spoolRoot,
      PLUGIN_DATA: box.pluginData,
    }
    const proc = Bun.spawn(["sh", join(import.meta.dir, "../bin/hook")], {
      env,
      stdin: Buffer.from(JSON.stringify(event("pre_tool", box.sessionId, "/work/app"))),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
    expect((await ownerOf(box.spool, box.sessionId))?.status).toBe("working")
    expect((await loadState(box.pluginData, box.sessionId))?.cwd).toBe("/work/app")
  })
})
