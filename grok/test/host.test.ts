import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { encodeMessage, LineReader } from "../src/frame.ts"
import { messageRecord } from "../src/shared/peer.ts"
import { parseOwner } from "../src/shared/protocol.ts"
import { Spool } from "../src/shared/spool.ts"
import { handleEvent, hookReply } from "../src/handle.ts"
import { runtimeDir, spoolRootFromEnv } from "../src/paths.ts"
import { readSummary } from "../src/summary.ts"
import { peerIdOf, saveState, type SessionState } from "../src/state.ts"
import { callTool } from "../src/tools.ts"

import { refreshAll } from "../src/daemon.ts"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "maki-peer-grok-"))
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

function files(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function layout(root: string): { spoolRoot: string; runtime: string; env: NodeJS.ProcessEnv } {
  const spoolRoot = join(root, "peers")
  const env = { ...process.env, HOME: root, GROK_HOME: join(root, "grok-home"), MAKI_PEER_SPOOL: spoolRoot }
  return { spoolRoot, runtime: runtimeDir(spoolRoot), env }
}

const session = "ses_grok_one"
const pid = process.pid

async function emit(
  box: ReturnType<typeof layout>,
  event: Record<string, unknown>,
  grokPid = pid,
): Promise<string> {
  return handleEvent({ event, grokPid, spoolRoot: box.spoolRoot, runtime: box.runtime, env: box.env })
}

describe("runtime directory", () => {
  test("follows the spool, including the ~/.maki takeover", () => {
    const home = tempRoot()
    const env = { HOME: home }
    expect(runtimeDir(spoolRootFromEnv(env))).toBe(join(home, ".local/state/maki/grok-peer"))
    mkdirSync(join(home, ".maki"))
    expect(runtimeDir(spoolRootFromEnv(env))).toBe(join(home, ".maki/grok-peer"))
  })

  test("the hook script resolves the same directory", async () => {
    const home = tempRoot()
    const script = join(import.meta.dir, "../bin/hook")
    const xdg = await Bun.$`sh ${script} --runtime-dir`.env({ ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg") }).text()
    expect(xdg.trim()).toBe(runtimeDir(spoolRootFromEnv({ HOME: home, XDG_STATE_HOME: join(home, "xdg") })))
    mkdirSync(join(home, ".maki"))
    const taken = await Bun.$`sh ${script} --runtime-dir`.env({ ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg") }).text()
    expect(taken.trim()).toBe(join(home, ".maki/grok-peer"))
    const over = await Bun.$`sh ${script} --runtime-dir`.env({ ...process.env, HOME: home, MAKI_PEER_SPOOL: join(home, "custom/peers") }).text()
    expect(over.trim()).toBe(join(home, "custom/grok-peer"))
  })
})

describe("presence", () => {
  test("a session start publishes a grok record and keeps the inbox on end", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    const owner = parseOwner(read(spool.ownerPath(peerIdOf(session))))
    expect(owner?.origin?.host).toBe("grok")
    expect(owner?.name.startsWith("grok-")).toBe(true)
    expect(owner?.id.startsWith("gk-")).toBe(true)
    expect(owner?.status).toBe("idle")
    expect(owner?.cwd).toBe("/work")
    expect(owner?.session_id).toBe(session)

    await spool.ensureInbox(peerIdOf(session))
    await emit(box, { hook_event_name: "SessionEnd", sessionId: session })
    expect(existsSync(spool.ownerPath(peerIdOf(session)))).toBe(false)
    expect(existsSync(spool.inboxPath(peerIdOf(session)))).toBe(true)
  })

  test("a subagent teardown leaves the session in place", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    await emit(box, { hook_event_name: "SessionEnd", sessionId: session, subagentType: "explore" })
    expect(existsSync(spool.ownerPath(peerIdOf(session)))).toBe(true)
  })

  test("status follows the turn, and a title is read from the session store", async () => {
    const box = layout(tempRoot())
    const cwd = "/work"
    const summaryDir = join(box.env.GROK_HOME ?? "", "sessions", encodeURIComponent(cwd), session)
    mkdirSync(summaryDir, { recursive: true })
    writeFileSync(join(summaryDir, "summary.json"), JSON.stringify({ generated_title: "hello\nworld", current_model_id: "grok-4" }))
    expect(readSummary(session, cwd, box.env).title).toBe("hello world")

    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd })
    const spool = new Spool(box.spoolRoot)
    expect(parseOwner(read(spool.ownerPath(peerIdOf(session))))?.title).toBe("hello world")
    expect(parseOwner(read(spool.ownerPath(peerIdOf(session))))?.model).toBe("grok-4")

    await emit(box, { hook_event_name: "UserPromptSubmit", sessionId: session, cwd })
    expect(parseOwner(read(spool.ownerPath(peerIdOf(session))))?.status).toBe("working")
    await emit(box, { hook_event_name: "Notification", notification_type: "permission_prompt", sessionId: session, cwd })
    expect(parseOwner(read(spool.ownerPath(peerIdOf(session))))?.status).toBe("needs_input")
    await emit(box, { hookEventName: "stop", sessionId: session, cwd })
    expect(parseOwner(read(spool.ownerPath(peerIdOf(session))))?.status).toBe("idle")
  })

  test("a dead grok process loses its record and keeps its inbox", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    const child = Bun.spawn(["true"])
    await child.exited
    const state: SessionState = {
      sessionId: session,
      grokPid: child.pid,
      busy: false,
      waiting: false,
      started: 1,
      detailChecked: Date.now(),
      cwd: "/work",
    }
    await saveState(box.runtime, state)
    const { publish } = await import("../src/state.ts")
    await spool.prepare()
    await publish(spool, state)
    await spool.ensureInbox(peerIdOf(session))
    expect(await refreshAll(box.spoolRoot, box.runtime)).toBe(0)
    expect(existsSync(spool.ownerPath(peerIdOf(session)))).toBe(false)
    expect(existsSync(spool.inboxPath(peerIdOf(session)))).toBe(true)
  })
})

describe("delivery", () => {
  test("stop hands a foreign message to the session and removes it", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    const peer = peerIdOf(session)
    const record = messageRecord({
      id: "m-foreign",
      from: "peer-aaaaaaaa",
      fromName: "maki-aaaaaaaa",
      to: peer,
      body: "hello from maki",
      kind: "observation",
      session: "not-a-grok-session",
      host: "maki",
    })
    await spool.write(join(spool.inboxPath(peer), "m-foreign.json"), record)
    const reply = await emit(box, { hook_event_name: "Stop", sessionId: session, cwd: "/work" })
    const parsed = JSON.parse(reply) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop")
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[peer maki-aaaaaaaa peer-aaaaaaaa] hello from maki")
    expect(files(spool.inboxPath(peer)).filter((name) => name.endsWith(".json"))).toEqual([])
    expect(parseOwner(read(spool.ownerPath(peer)))?.status).toBe("working")
  })

  test("a grok message for a session this host does not run is dropped", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    const peer = peerIdOf(session)
    await spool.write(
      join(spool.inboxPath(peer), "m-gone.json"),
      messageRecord({
        id: "m-gone",
        from: "gk-0123456789abcdef",
        fromName: "grok-01234567",
        to: peer,
        body: "for a session that ended",
        kind: "observation",
        session: "ses_gone",
        host: "grok",
      }),
    )
    const reply = await emit(box, { hook_event_name: "Stop", sessionId: session, cwd: "/work" })
    expect(reply).toBe("")
    expect(existsSync(join(spool.inboxPath(peer), "m-gone.json"))).toBe(false)
  })

  test("a long delivery is cut under the hook cap", () => {
    const reply = hookReply("Stop", ["x".repeat(9001)])
    const parsed = JSON.parse(reply) as { hookSpecificOutput: { additionalContext: string } }
    expect(parsed.hookSpecificOutput.additionalContext.endsWith("\n[truncated]")).toBe(true)
    expect(parsed.hookSpecificOutput.additionalContext.length).toBe(9000 + "\n[truncated]".length)
  })

  test("an empty inbox leaves the hook silent", async () => {
    const box = layout(tempRoot())
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    expect(await emit(box, { hook_event_name: "PostToolUse", sessionId: session, cwd: "/work" })).toBe("")
  })
})

describe("tools", () => {
  test("send stamps grok as the origin and omits a session the other host cannot use", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    const now = Math.floor(Date.now() / 1000)
    await spool.write(spool.ownerPath("peer-target"), {
      protocol: 1,
      id: "peer-target",
      name: "maki-target1",
      started: now,
      last_seen: now,
      status: "idle",
      cwd: "/work",
      origin: { host: "maki" },
    })
    const sent = await callTool(spool, box.runtime, { pid, sessionId: session }, "peer_send", {
      peer_id: "maki-target1",
      message: "found an edge",
      session: "should-not-stick",
    })
    expect(sent.error).toBe(false)
    const inbox = files(spool.inboxPath("peer-target")).filter((name) => name.endsWith(".json"))
    expect(inbox.length).toBe(1)
    const queued = read(join(spool.inboxPath("peer-target"), inbox[0] ?? ""))
    expect(queued.origin).toEqual({ host: "grok" })
    expect(queued.session).toBeUndefined()
    expect(queued.from).toBe(peerIdOf(session))
  })

  test("a session is written only when the receiver is grok, and self is refused", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    const other = "ses_grok_two"
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    await emit(box, { hook_event_name: "SessionStart", sessionId: other, cwd: "/elsewhere" }, pid)
    const sent = await callTool(spool, box.runtime, { pid, sessionId: session }, "peer_send", {
      peer_id: peerIdOf(other),
      message: "same host",
      session: other,
    })
    expect(sent.error).toBe(false)
    const name = files(spool.inboxPath(peerIdOf(other))).find((item) => item.endsWith(".json")) ?? ""
    expect(read(join(spool.inboxPath(peerIdOf(other)), name)).session).toBe(other)

    const self = await callTool(spool, box.runtime, { pid, sessionId: session }, "peer_send", {
      peer_id: peerIdOf(session),
      message: "no",
    })
    expect(self.error).toBe(true)
  })

  test("broadcast with same_dir_only skips another directory", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    const now = Math.floor(Date.now() / 1000)
    for (const [id, cwd] of [
      ["peer-same", "/work"],
      ["peer-other", "/elsewhere"],
    ] as const) {
      await spool.write(spool.ownerPath(id), {
        protocol: 1,
        id,
        name: `maki-${id}`,
        started: now,
        last_seen: now,
        status: "idle",
        cwd,
        origin: { host: "maki" },
      })
    }
    const limited = await callTool(spool, box.runtime, { pid, sessionId: session }, "peer_broadcast", {
      message: "team",
      same_dir_only: true,
    })
    expect(limited.text).toBe("Queued 1 peer messages.")
    expect(files(spool.inboxPath("peer-same")).filter((name) => name.endsWith(".json")).length).toBe(1)
    expect(files(spool.inboxPath("peer-other"))).toEqual([])
  })

  test("two sessions on one process are not guessed", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    await emit(box, { hook_event_name: "SessionStart", sessionId: "ses_grok_two", cwd: "/work" })
    const result = await callTool(spool, box.runtime, { pid }, "peer_send", { peer_id: "maki-target1", message: "hi" })
    expect(result.error).toBe(true)
    expect(result.text).toContain("which one asked")
  })

  test("peer_list marks the session that asked", async () => {
    const box = layout(tempRoot())
    const spool = new Spool(box.spoolRoot)
    await emit(box, { hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
    const listed = await callTool(spool, box.runtime, { pid, sessionId: session }, "peer_list", {})
    expect(listed.text).toContain("(you)")
    expect(listed.text).toContain("via grok")
  })
})

describe("frames", () => {
  test("a json line round trips, including a split chunk", () => {
    const reader = new LineReader()
    const bytes = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" })
    reader.push(bytes.subarray(0, 5))
    expect(reader.drain()).toEqual([])
    reader.push(bytes.subarray(5))
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
  test("registers a session and returns mail from the daemon", async () => {
    const root = tempRoot()
    const spoolRoot = join(root, "peers")
    const runtime = runtimeDir(spoolRoot)
    const env = { ...process.env, HOME: root, GROK_HOME: join(root, "empty-grok"), MAKI_PEER_SPOOL: spoolRoot }
    const script = join(import.meta.dir, "../bin/hook")
    const run = async (event: unknown) => {
      const proc = Bun.spawn(["sh", script], {
        env,
        stdin: Buffer.from(JSON.stringify(event)),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
        proc.exited,
      ])
      return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }
    }
    try {
      const started = await run({ hook_event_name: "SessionStart", sessionId: session, cwd: "/work" })
      expect(started.exitCode).toBe(0)
      expect(started.stdout.toString()).toBe("")
      const spool = new Spool(spoolRoot)
      expect(parseOwner(read(spool.ownerPath(peerIdOf(session))))?.origin?.host).toBe("grok")
      await spool.write(
        join(spool.inboxPath(peerIdOf(session)), "m-live.json"),
        messageRecord({
          id: "m-live",
          from: "peer-aaaaaaaa",
          fromName: "maki-aaaaaaaa",
          to: peerIdOf(session),
          body: "through the daemon",
          kind: "observation",
          host: "maki",
        }),
      )
      const stopped = await run({ hook_event_name: "Stop", sessionId: session, cwd: "/work" })
      expect(stopped.exitCode).toBe(0)
      expect(stopped.stdout.toString()).toContain("through the daemon")
    } finally {
      if (existsSync(join(runtime, "daemon.lock"))) {
        const daemon = Number(readFileSync(join(runtime, "daemon.lock"), "utf8"))
        if (daemon > 0) {
          try {
            process.kill(daemon, "SIGTERM")
          } catch {
            /* already gone */
          }
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
})
