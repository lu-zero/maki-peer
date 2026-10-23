import { deliveryText } from "./shared/peer.ts"
import { DETAIL_REFRESH_SECONDS, validId, type PeerMessage } from "./shared/protocol.ts"
import { receiveOnce } from "./shared/receive.ts"
import { Spool } from "./shared/spool.ts"
import { readSummary } from "./summary.ts"
import {
  appendPending,
  listStates,
  loadState,
  peerIdOf,
  publish,
  removeState,
  saveState,
  takePending,
  unpublish,
  type SessionState,
} from "./state.ts"

const MAX_HOOK_CHARS = 9000

const EVENT_NAMES: Record<string, string> = {
  session_start: "SessionStart",
  session_end: "SessionEnd",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  stop: "Stop",
  stop_cancelled: "StopCancelled",
  notification: "Notification",
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Claude's PascalCase name when it is present, otherwise grok's snake_case one. */
export function canonicalEvent(event: unknown): string {
  const body = record(event)
  const pascal = text(body.hook_event_name)
  if (pascal) return pascal
  const snake = text(body.hookEventName) ?? ""
  return EVENT_NAMES[snake] ?? snake
}

function sessionOf(event: unknown): string | undefined {
  const body = record(event)
  const id = text(body.sessionId) ?? text(body.session_id)
  return id && validId(id) ? id : undefined
}

function subagentOf(event: unknown): boolean {
  const body = record(event)
  return text(body.subagentType) !== undefined || text(body.subagent_type) !== undefined
}

function noteOf(event: unknown): string {
  const body = record(event)
  return text(body.notificationType) ?? text(body.notification_type) ?? ""
}

function cwdOf(event: unknown): string | undefined {
  const body = record(event)
  return text(body.cwd) ?? text(body.workspaceRoot)
}

/**
 * The text a hook prints. Empty means the hook has nothing to add.
 *
 * Stop treats additionalContext as a reason to keep the turn going, which is
 * how mail that arrived during the turn reaches the model. PostToolUse attaches
 * the same text to the tool result. The host clips the field at 10,000
 * characters, so the body is cut under that.
 */
export function hookReply(event: "PostToolUse" | "Stop", lines: string[]): string {
  if (lines.length === 0) return ""
  let textBody = lines.join("\n")
  if (textBody.length > MAX_HOOK_CHARS) textBody = `${textBody.slice(0, MAX_HOOK_CHARS)}\n[truncated]`
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: textBody },
  })
}

async function drain(input: {
  spool: Spool
  runtime: string
  sessionId: string
  ownSessions: ReadonlySet<string>
}): Promise<string[]> {
  const lines: string[] = []
  await receiveOnce({
    spool: input.spool,
    peerID: peerIdOf(input.sessionId),
    instance: `grok-${process.pid}`,
    host: "grok",
    addressing: {
      ownSession: input.sessionId,
      owns: (id) => input.ownSessions.has(id),
    },
    deliver: async (message: PeerMessage, target: string) => {
      const rendered = deliveryText(message)
      if (target === input.sessionId) {
        lines.push(rendered)
        return "delivered"
      }
      if (input.ownSessions.has(target)) {
        await appendPending(input.runtime, target, rendered)
        return "delivered"
      }
      return "retry"
    },
  })
  const pending = await takePending(input.runtime, input.sessionId)
  return [...pending, ...lines]
}

/**
 * Apply one hook event.
 *
 * A subagent event is ignored. Its session is not a peer, and its teardown
 * must not retire the session that spawned it. Presence is written here, and
 * the daemon writes it again on a timer so an idle session stays visible.
 */
export async function handleEvent(input: {
  event: unknown
  grokPid: number
  spoolRoot: string
  runtime: string
  env?: NodeJS.ProcessEnv
}): Promise<string> {
  if (subagentOf(input.event)) return ""
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
    grokPid: input.grokPid,
    busy: false,
    waiting: false,
    started: Math.floor(now / 1000),
    detailChecked: 0,
  }
  if (input.grokPid > 0) state.grokPid = input.grokPid
  const cwd = cwdOf(input.event)
  if (cwd) state.cwd = cwd

  const note = noteOf(input.event)
  if (name === "SessionStart" || name === "StopCancelled" || note === "idle_prompt") {
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
    const own = new Set((await listStates(input.runtime)).map((item) => item.sessionId))
    own.add(sessionId)
    const lines = await drain({ spool, runtime: input.runtime, sessionId, ownSessions: own })
    reply = hookReply(name, lines)
    if (name === "Stop") {
      state.busy = lines.length > 0
      state.waiting = false
    }
  }

  if (name === "SessionStart" || now - state.detailChecked >= DETAIL_REFRESH_SECONDS * 1000) {
    try {
      const detail = readSummary(sessionId, state.cwd, input.env)
      if (detail.title) state.title = detail.title
      if (detail.model) state.model = detail.model
      state.detailChecked = now
    } catch {
      /* a missing session store leaves the title blank until the next pass */
    }
  }

  await saveState(input.runtime, state)
  await publish(spool, state).catch(() => {})
  return reply
}
