import { LineReader, encodeMessage } from "./frame.ts"
import { channelsEnabled, runtimeDir, spoolRootFromEnv } from "./paths.ts"
import { actingSession, listStates, peerIdOf, type SessionState } from "./state.ts"
import { callTool } from "./tools.ts"
import { deliveryText } from "./shared/peer.ts"
import { originHost, type PeerMessage } from "./shared/protocol.ts"
import { receiveOnce } from "./shared/receive.ts"
import { Spool } from "./shared/spool.ts"

const TOOLS = [
  {
    name: "peer_list",
    description: "List peer instances registered",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "peer_cwd",
    description: "Report the working directory of each live peer as a JSON object from full peer id to path, or null when a peer reports no directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "peer_send",
    description: "Send an observation or status to one named peer, on either host, and to that peer only. This is the default way to reach another agent: prefer it to a broadcast unless you really do mean everyone. Two agents working closely together use this.",
    inputSchema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "Target peer id or name, as printed by peer_list" },
        message: { type: "string", description: "Observation to deliver" },
        topic: { type: "string", description: "Short subject of the message, shown before the body" },
        session: { type: "string", description: "Optional session id on the receiving host" },
        kind: { type: "string", enum: ["observation", "status"] },
        wake: { type: "boolean", description: "Wake the receiving session if it is idle, so the message starts a turn instead of waiting" },
      },
      required: ["peer_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_broadcast",
    description: "Send an observation to EVERY peer on this machine, Maki and OpenCode alike, including sessions belonging to other work and to other people. Each recipient gets it as a message in their own session, so it lands in context you do not control. Broadcast when the whole machine should know, such as a system wide action or a change other people depend on, and use same_dir_only to reach the team working in one directory. Two agents working closely together should use peer_send.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Observation to deliver" },
        topic: { type: "string", description: "Short subject of the message, shown before the body" },
        session: { type: "string", description: "Optional session id on the receiving host" },
        kind: { type: "string", enum: ["observation", "status"] },
        wake: { type: "boolean", description: "Wake the receiving session if it is idle, so the message starts a turn instead of waiting" },
        same_dir_only: {
          type: "boolean",
          description: "Only peers reporting the same directory, where this host reports one",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
]

/** Only spool records from known local hosts may become channel events. */
const HOSTS = new Set(["maki", "opencode", "grok", "vibe", "claude"])

type Request = {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: Record<string, unknown>
}

function reply(id: unknown, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result }
}

function failure(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

export function capabilities(channel: boolean): Record<string, unknown> {
  return {
    tools: { listChanged: false },
    ...(channel ? { experimental: { "claude/channel": {} } } : {}),
  }
}

function hint(): { pid: number; sessionId?: string } {
  const sessionId = process.env.CLAUDE_SESSION_ID
  return {
    pid: process.ppid,
    ...(typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {}),
  }
}

async function onMessage(message: unknown, channel: boolean): Promise<unknown | undefined> {
  const request = message as Request
  if (request.id === undefined || request.id === null) return undefined
  if (request.method === "initialize") {
    const params = request.params ?? {}
    const version = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05"
    return reply(request.id, {
      protocolVersion: version,
      capabilities: capabilities(channel),
      serverInfo: { name: "maki-peer", version: "0.1.0" },
    })
  }
  if (request.method === "ping") return reply(request.id, {})
  if (request.method === "tools/list") return reply(request.id, { tools: TOOLS })
  if (request.method === "tools/call") {
    const params = request.params ?? {}
    const name = typeof params.name === "string" ? params.name : ""
    const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {}
    const spoolRoot = spoolRootFromEnv()
    const result = await callTool(new Spool(spoolRoot), runtimeDir(spoolRoot), hint(), name, args)
    return reply(request.id, {
      content: [{ type: "text", text: result.text }],
      ...(result.error ? { isError: true } : {}),
    })
  }
  return failure(request.id, -32601, `method not found: ${request.method ?? ""}`)
}

export async function channelEvent(
  output: NodeJS.WritableStream,
  sessionHint: { pid: number; sessionId?: string } = hint(),
): Promise<void> {
  const spoolRoot = spoolRootFromEnv()
  const runtime = runtimeDir(spoolRoot)
  const self = await actingSession(runtime, sessionHint)
  if ("error" in self) return
  const state: SessionState = self
  const spool = new Spool(spoolRoot)
  await spool.prepare()
  const own = new Set((await listStates(runtime)).map((item) => item.sessionId))
  await receiveOnce({
    spool,
    peerID: peerIdOf(state.sessionId),
    instance: `claude-channel-${process.pid}`,
    host: "claude",
    addressing: { ownSession: state.sessionId, owns: (sessionID: string) => own.has(sessionID) },
    deliver: async (message: PeerMessage, target: string) => {
      const host = originHost(message)
      if (!HOSTS.has(host) || target !== state.sessionId) return "retry"
      const event = {
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: {
          content: deliveryText(message),
          meta: { peer_id: message.from, origin_host: host },
        },
      }
      output.write(encodeMessage(event))
      return "delivered"
    },
  })
}

export async function serve(
  input: AsyncIterable<Uint8Array>,
  output: NodeJS.WritableStream,
  options: { channel?: boolean } = {},
): Promise<void> {
  const channel = options.channel ?? channelsEnabled()
  let timer: ReturnType<typeof setInterval> | undefined
  let pumping = Promise.resolve()
  if (channel) {
    timer = setInterval(() => {
      pumping = pumping.then(() => channelEvent(output, hint())).catch(() => {})
    }, 2000)
  }
  try {
    const reader = new LineReader()
    for await (const chunk of input) {
      reader.push(Buffer.from(chunk))
      for (const message of reader.drain()) {
        const response = await onMessage(message, channel)
        if (response !== undefined) output.write(encodeMessage(response))
      }
    }
  } finally {
    if (timer) clearInterval(timer)
    await pumping
  }
}

if (import.meta.main) {
  await serve(Bun.stdin.stream(), process.stdout)
}
