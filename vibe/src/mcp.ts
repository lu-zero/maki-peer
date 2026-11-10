import { encodeMessage, LineReader } from "./frame.ts"
import { sessionIdFromPluginData } from "./identity.ts"
import { spoolRootFromEnv } from "./paths.ts"
import { publish, unpublish } from "./presence.ts"
import { OWNER_REFRESH_MS } from "./shared/protocol.ts"
import { Spool } from "./shared/spool.ts"
import { updateState, withStateLock } from "./state.ts"
import { callTool } from "./tools.ts"

const TOOLS = [
  {
    name: "peer_list",
    description: "List peer instances registered",
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

type Request = {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: Record<string, unknown>
}

export type McpHost = { spoolRoot: string; pluginData?: string }

function reply(id: unknown, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result }
}

function failure(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

async function onMessage(message: unknown, host: McpHost): Promise<unknown | undefined> {
  const request = message as Request
  if (request.id === undefined || request.id === null) return undefined
  if (request.method === "initialize") {
    const params = request.params ?? {}
    const version = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05"
    return reply(request.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "maki-peer", version: "0.1.0" },
    })
  }
  if (request.method === "ping") return reply(request.id, {})
  if (request.method === "tools/list") return reply(request.id, { tools: TOOLS })
  if (request.method === "tools/call") {
    const params = request.params ?? {}
    const name = typeof params.name === "string" ? params.name : ""
    const args =
      typeof params.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {}
    const result = await callTool(new Spool(host.spoolRoot), host.pluginData, name, args)
    return reply(request.id, {
      content: [{ type: "text", text: result.text }],
      ...(result.error ? { isError: true } : {}),
    })
  }
  return failure(request.id, -32601, `method not found: ${request.method ?? ""}`)
}

/**
 * Serve MCP and refresh presence until stdin closes.
 *
 * Writes are queued so the last one is the removal. A heartbeat that started
 * before shutdown must not put the record back after it was removed.
 */
export async function serve(
  input: AsyncIterable<Uint8Array>,
  output: NodeJS.WritableStream,
  host: McpHost,
): Promise<void> {
  const spool = new Spool(host.spoolRoot)
  const sessionId = host.pluginData ? sessionIdFromPluginData(host.pluginData) : undefined
  let closed = false
  let tail = Promise.resolve()
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const run = tail.then(job, job)
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }
  const beat = (): Promise<void> =>
    enqueue(async () => {
      if (closed || !sessionId || !host.pluginData) return
      const pluginData = host.pluginData
      const id = sessionId
      await withStateLock(pluginData, async () => {
        if (closed) return
        const state = await updateState(pluginData, id, {})
        if (state && !closed) await publish(spool, state)
      })
    })
  await beat()
  const timer = setInterval(() => {
    void beat()
  }, OWNER_REFRESH_MS)
  try {
    const reader = new LineReader()
    for await (const chunk of input) {
      reader.push(Buffer.from(chunk))
      for (const message of reader.drain()) {
        const response = await onMessage(message, host)
        if (response !== undefined) output.write(encodeMessage(response))
      }
    }
  } finally {
    closed = true
    clearInterval(timer)
    await enqueue(async () => {
      if (!sessionId || !host.pluginData) return
      const pluginData = host.pluginData
      await withStateLock(pluginData, async () => {
        await unpublish(spool, sessionId)
      })
    })
  }
}

export async function main(): Promise<void> {
  await serve(Bun.stdin.stream(), process.stdout, {
    spoolRoot: spoolRootFromEnv(),
    ...(process.env.PLUGIN_DATA ? { pluginData: process.env.PLUGIN_DATA } : {}),
  })
}

if (import.meta.main) {
  await main()
}
