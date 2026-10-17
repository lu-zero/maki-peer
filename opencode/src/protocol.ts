export const PROTOCOL_VERSION = 1
export const ORIGIN_HOST = "opencode"

export const POLL_MS = 500
export const OWNER_REFRESH_MS = 2000
export const OWNER_STALE_SECONDS = 15
export const MESSAGE_TTL_SECONDS = 300
export const MAX_INBOX = 100
export const MAX_BODY_BYTES = 262144
export const MAX_RECORD_BYTES = MAX_BODY_BYTES + 4096

/**
 * How far past the stale window a record may sit before a sweep may claim it.
 * Twenty times the window: a host blocked in a long synchronous call stops
 * refreshing, but peers have already dropped it by then, so the record backs
 * nothing that is still true.
 */
export const GC_MARK_AFTER_SECONDS = 300
export const GC_SWEEP_INTERVAL_SECONDS = 3600

/** How often a host re-reads its own sessions for title and directory. */
export const DETAIL_REFRESH_SECONDS = 300

/**
 * How long a delivery may hold a claim on a message before any poller may put
 * it back in the queue. A live delivery finishes in well under this, so the
 * timeout is what keeps a crashed poller from wedging an inbox forever while
 * at-least-once delivery stays intact.
 */
export const CLAIM_TIMEOUT_SECONDS = 60

/** Hex characters of the peer id a peer name is built from. Eight, the whole
 * time field in a maki id: sequential maki reloads were observed sharing their
 * first six characters twice in one spool, and six was also observed colliding
 * on maki names fifteen minutes after the width was chosen. */
export const NAME_HEX_WIDTH = 8
/** A title is a label, not a paragraph. */
export const MAX_TITLE_RUNES = 64

const ID_PATTERN = /^[\w-]+$/
const MAX_ID_LENGTH = 128

export function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id)
}

export type PeerStatus = "idle" | "working" | "needs_input"

export type Owner = {
  protocol: number
  id: string
  name: string
  started: number
  last_seen: number
  status: string
  model?: string
  /** Project root the host works in. Absent on a host that cannot report one. */
  cwd?: string
  /** Free text the host shows for this session. Rendered, never acted on. */
  title?: string
  /**
   * Identifies the plugin instance that wrote the record, so a reload can take
   * its own sessions back. Stable across reloads, so it is only ever compared
   * against records from the same host.
   */
  instance?: string
  /** The session this peer is, in the writing host's own id format. */
  session_id?: string
  origin?: { host?: unknown }
}

export type PeerMessage = {
  protocol: number
  id: string
  from: string
  from_name: string
  to: string
  kind: "observation" | "status"
  body: string
  session?: string
  origin?: { host?: unknown }
  created: number
  expires: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A presence record is only usable if every field maki reads is well formed. */
export function parseOwner(value: unknown): Owner | undefined {
  if (!isRecord(value)) return undefined
  if (value.protocol !== PROTOCOL_VERSION) return undefined
  if (!validId(value.id)) return undefined
  if (typeof value.name !== "string") return undefined
  const started = finite(value.started)
  const lastSeen = finite(value.last_seen)
  if (started === undefined || lastSeen === undefined) return undefined
  return {
    protocol: value.protocol,
    id: value.id,
    name: value.name,
    started,
    last_seen: lastSeen,
    status: typeof value.status === "string" ? value.status : "idle",
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.cwd === "string" && value.cwd !== "" ? { cwd: value.cwd } : {}),
    ...(titleOf(value.title) ? { title: titleOf(value.title) } : {}),
    ...(typeof value.instance === "string" && value.instance !== "" ? { instance: value.instance } : {}),
    ...(typeof value.session_id === "string" && value.session_id !== "" ? { session_id: value.session_id } : {}),
    ...(isRecord(value.origin) ? { origin: { host: value.origin.host } } : {}),
  }
}

/**
 * Make a title safe to print on one list line.
 *
 * It is free text written by another session, so a newline would inject a fake
 * row and an escape sequence would do worse. Runs of whitespace collapse to a
 * single space, which is also what a reader wants, and the cap counts runes so
 * it cannot split a code point in half.
 */
export function titleOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const flat = value.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim()
  if (flat === "") return undefined
  const runes = [...flat]
  return runes.length > MAX_TITLE_RUNES ? runes.slice(0, MAX_TITLE_RUNES).join("").trimEnd() : flat
}

/**
 * Two hosts share a tree when they report the same root. The record is optional,
 * so a host that reports nothing is never counted as matching.
 */
export function sameTree(a: { cwd?: string }, b: { cwd?: string }): boolean {
  if (!a.cwd || !b.cwd) return false
  return stripTrailingSlash(a.cwd) === stripTrailingSlash(b.cwd)
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

/**
 * The host a record claims to come from. A record written before `origin`
 * existed predates cross-host peers, so it is treated as maki's own.
 */
export function originHost(message: { origin?: { host?: unknown } }): string {
  const host = message.origin?.host
  return typeof host === "string" ? host : "maki"
}

export function parseMessage(value: unknown, to: string): PeerMessage | undefined {
  if (!isRecord(value)) return undefined
  if (value.protocol !== PROTOCOL_VERSION) return undefined
  if (value.to !== to) return undefined
  if (!validId(value.id) || !validId(value.from)) return undefined
  if (typeof value.body !== "string" || value.body.length > MAX_BODY_BYTES) return undefined
  if (value.kind !== "observation" && value.kind !== "status") return undefined
  if (value.session !== undefined && typeof value.session !== "string") return undefined
  const created = finite(value.created)
  const expires = finite(value.expires)
  if (created === undefined || expires === undefined) return undefined
  return {
    protocol: value.protocol,
    id: value.id,
    from: value.from,
    from_name: typeof value.from_name === "string" ? value.from_name : value.from,
    to,
    kind: value.kind,
    body: value.body,
    ...(typeof value.session === "string" ? { session: value.session } : {}),
    ...(isRecord(value.origin) ? { origin: { host: value.origin.host } } : {}),
    created,
    expires,
  }
}
