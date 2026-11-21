import { deliveryText } from "./shared/peer.ts"
import { receiveOnce } from "./shared/receive.ts"
import { Spool } from "./shared/spool.ts"
import { listStates, loadState, peerIdOf, publish, removeState, saveState, unpublish, type SessionState } from "./state.ts"

const MAX_HOOK_CHARS = 9000

const EVENT_NAMES: Record<string, string> = {
  session_start: "SessionStart",
  session_end: "SessionEnd",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  stop: "Stop",
  notification: "Notification",
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Claude's PascalCase name when present, otherwise a snake_case one. */
export function canonicalEvent(event: unknown): string {
  const body = record(event)
  const pascal = text(body.hook_event_name)
  if (pascal) return pascal
  const snake = text(body.hookEventName) ?? ""
  return EVENT_NAMES[snake] ?? snake
}

function sessionOf(event: unknown): string | undefined {
  const body = record(event)
  const id = text(body.session_id) ?? text(body.sessionId)
  return id && /^[\w-]+$/.test(id) && id.length <= 128 ? id : undefined
}

function cwdOf(event: unknown): string | undefined {
  return text(record(event).cwd)
}

function noteOf(event: unknown): string {
  const body = record(event)
  return text(body.notification_type) ?? text(body.notificationType) ?? ""
}

/** The text a hook prints. Empty means the hook has nothing to add. */
export function hookReply(event: "PostToolUse" | "Stop", lines: string[]): string {
  if (lines.length === 0) return ""
  let body = lines.join("\n")
  if (body.length > MAX_HOOK_CHARS) body = `${body.slice(0, MAX_HOOK_CHARS)}\n[truncated]`
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: body } })
}

async function drain(
  spool: Spool,
  runtime: string,
  sessionId: string,
): Promise<string[]> {
  const lines: string[] = []
  const own = new Set((await listStates(runtime)).map((state) => state.sessionId))
  own.add(sessionId)
  await receiveOnce({
    spool,
    peerID: peerIdOf(sessionId),
    instance: `claude-${process.pid}`,
    host: "claude",
    addressing: {
      ownSession: sessionId,
      owns: (sessionID: string) => own.has(sessionID),
    },
    deliver: async (message, target) => {
      const rendered = deliveryText(message)
      if (target === sessionId || own.has(target)) {
        lines.push(rendered)
        return "delivered"
      }
      return "retry"
    },
  })
  return lines
}

export async function handleEvent(input: {
  event: unknown
  claudePid: number
  spoolRoot: string
  runtime: string
}): Promise<string> {
  const sessionId = sessionOf(input.event)
  if (!sessionId) return ""
  const spool = new Spool(input.spoolRoot)
  await spool.prepare()
  const name = canonicalEvent(input.event)
  if (name === "SessionEnd") {
    await unpublish(spool, sessionId)
    await removeState(input.runtime, sessionId)
    return ""
  }

  const now = Date.now()
  const existing = await loadState(input.runtime, sessionId)
  const state: SessionState = existing ?? {
    sessionId,
    claudePid: input.claudePid,
    busy: false,
    waiting: false,
    started: Math.floor(now / 1000),
  }
  if (input.claudePid > 0) state.claudePid = input.claudePid
  const cwd = cwdOf(input.event)
  if (cwd) state.cwd = cwd

  const note = noteOf(input.event)
  if (name === "SessionStart" || name === "Stop" || note === "idle_prompt") {
    state.busy = false
    state.waiting = false
  }
  if (name === "UserPromptSubmit" || name === "PostToolUse") {
    state.busy = true
    state.waiting = false
  }
  if (note === "permission_prompt") state.waiting = true

  let reply = ""
  if (name === "PostToolUse" || name === "Stop") {
    const lines = await drain(spool, input.runtime, sessionId)
    reply = hookReply(name as "PostToolUse" | "Stop", lines)
    // Stop ends the turn. Attaching a note here does not make the agent busy,
    // and leaving the flag set would show this peer as working while it is idle.
    if (name === "Stop") state.busy = false
  }

  await saveState(input.runtime, state)
  await publish(spool, state).catch(() => {})
  return reply
}

