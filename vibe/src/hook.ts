import { takeMail } from "./deliver.ts"
import { sessionForHook } from "./identity.ts"
import { spoolRootFromEnv } from "./paths.ts"
import { publish } from "./presence.ts"
import { Spool } from "./shared/spool.ts"
import { updateState, withStateLock } from "./state.ts"

export type HookPaths = { spoolRoot: string; pluginData?: string }

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * Apply one Vibe hook and return the stdout the host should see.
 *
 * `pre_agent` marks the session working and is the point mail lands at a turn
 * start, including one that starts an idle session. `pre_tool` marks the
 * session working. `post_tool` claims mail after a tool call, so a message
 * that arrives mid-turn still attaches. `post_agent` marks the session idle
 * and prints nothing: a deny would ask for a retry, and the host ignores any
 * other text.
 */
export async function handleHook(event: unknown, paths: HookPaths): Promise<string> {
  const body = record(event)
  const name = text(body.hook_event_name)
  const sessionId = sessionForHook(paths.pluginData, text(body.session_id))
  if (!sessionId || !paths.pluginData) return ""
  if (name !== "pre_agent" && name !== "pre_tool" && name !== "post_tool" && name !== "post_agent") return ""
  const pluginData = paths.pluginData

  return withStateLock(pluginData, async () => {
    const cwd = text(body.cwd)
    const state = await updateState(pluginData, sessionId, {
      busy: name !== "post_agent",
      ...(cwd ? { cwd } : {}),
    })
    if (!state) return ""
    const spool = new Spool(paths.spoolRoot)
    await publish(spool, state)
    if (name !== "post_tool" && name !== "pre_agent") return ""
    return takeMail(spool, sessionId)
  })
}

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (raw === "") return
  let event: unknown
  try {
    event = JSON.parse(raw) as unknown
  } catch {
    return
  }
  const reply = await handleHook(event, {
    spoolRoot: spoolRootFromEnv(),
    ...(process.env.PLUGIN_DATA ? { pluginData: process.env.PLUGIN_DATA } : {}),
  })
  if (reply) process.stdout.write(reply)
}

if (import.meta.main) {
  await main()
}
