import { createHash, randomBytes } from "node:crypto"

import {
  GC_MARK_AFTER_SECONDS,
  MESSAGE_TTL_SECONDS,
  NAME_HEX_WIDTH,
  ORIGIN_HOST,
  OWNER_REFRESH_MS,
  OWNER_STALE_SECONDS,
  PROTOCOL_VERSION,
  parseOwner,
  sameTree,
  titleOf,
  type Owner,
  type PeerStatus,
  validId,
} from "./protocol.js"
import { Spool } from "./spool.js"

/** The three states maki's `status_now` aggregates over. */
export function statusFor(state: { busy: boolean; waiting: boolean }): PeerStatus {
  if (state.waiting) return "needs_input"
  if (state.busy) return "working"
  return "idle"
}

/**
 * Derived from the session id so a plugin reload reuses the same presence
 * record instead of leaving an orphan for the stale window to reap.
 */
export function peerIdFor(sessionID: string): string {
  return `oc-${createHash("sha256").update(sessionID).digest("hex").slice(0, 16)}`
}

export type LivePeer = {
  sessionID: string
  id: string
  name: string
  started: number
  busy: boolean
  waiting: boolean
  model?: string
  cwd?: string
  title?: string
  dirty: boolean
  lastWrite: number
}

/**
 * A peer's name comes from its own id, so it is stable across reloads and
 * cannot be edited under the addressing rules. A session title is free text and
 * mutable, which is exactly why it is not the name.
 */
export function nameFromPeerID(label: string, peerID: string): string {
  const rest = peerID.replace(/^[a-z]+-/, "")
  return `${label}-${rest.slice(0, NAME_HEX_WIDTH)}`
}

export function peerStatus(peer: LivePeer): PeerStatus {
  return statusFor({ busy: peer.busy, waiting: peer.waiting })
}

export class PeerRegistry {
  private readonly live = new Map<string, LivePeer>()
  private readonly spool: Spool
  private readonly label: string
  private readonly instance?: string

  constructor(spool: Spool, label = "opencode", opts: { instance?: string } = {}) {
    this.spool = spool
    this.label = label
    this.instance = opts.instance
  }

  observe(sessionID: string, model?: string): LivePeer | undefined {
    if (!validId(sessionID)) return undefined
    const existing = this.live.get(sessionID)
    if (existing) {
      this.setModel(sessionID, model)
      return existing
    }
    const id = peerIdFor(sessionID)
    const peer: LivePeer = {
      sessionID,
      id,
      name: nameFromPeerID(this.label, id),
      started: Math.floor(Date.now() / 1000),
      busy: false,
      waiting: false,
      dirty: true,
      lastWrite: 0,
    }
    if (model) peer.model = model
    this.live.set(sessionID, peer)
    return peer
  }

  /** Title and directory come from the host's own view of the session. */
  setDetail(sessionID: string, detail: { title?: string; cwd?: string }): void {
    const peer = this.live.get(sessionID)
    if (!peer) return
    const title = titleOf(detail.title)
    if (title !== peer.title) {
      peer.title = title
      peer.dirty = true
    }
    if (detail.cwd && detail.cwd !== peer.cwd) {
      peer.cwd = detail.cwd
      peer.dirty = true
    }
  }

  /**
   * Take a session back after a reload. A host that lists sessions hands us
   * this for free on setup; opencode does not, so the records this instance
   * wrote before are the only evidence that a session is still running. Status
   * starts idle because the reload lost it, and the next event corrects it.
   */
  adopt(sessionID: string, record: Owner): LivePeer | undefined {
    if (!validId(sessionID)) return undefined
    const peer = this.observe(sessionID, record.model)
    if (!peer) return undefined
    peer.started = record.started
    peer.dirty = true
    return peer
  }

  get(sessionID: string): LivePeer | undefined {
    return this.live.get(sessionID)
  }

  has(sessionID: string): boolean {
    return this.live.has(sessionID)
  }

  setModel(sessionID: string, model?: string): void {
    const peer = this.live.get(sessionID)
    if (!peer || !model || peer.model === model) return
    peer.model = model
    peer.dirty = true
  }

  setBusy(sessionID: string, busy: boolean): void {
    const peer = this.live.get(sessionID)
    if (!peer || peer.busy === busy) return
    peer.busy = busy
    peer.dirty = true
  }

  setWaiting(sessionID: string, waiting: boolean): void {
    const peer = this.live.get(sessionID)
    if (!peer || peer.waiting === waiting) return
    peer.waiting = waiting
    peer.dirty = true
  }

  /**
   * Refresh presence records. Writes are throttled; a status or model change
   * flushes immediately so other hosts see it without waiting for the tick.
   */
  async flush(refreshMs: number): Promise<void> {
    const now = Date.now()
    for (const peer of this.live.values()) {
      if (!peer.dirty && now - peer.lastWrite < refreshMs) continue
      try {
        await this.spool.write(this.spool.ownerPath(peer.id), this.record(peer))
        peer.lastWrite = now
        peer.dirty = false
      } catch {
        /* the next tick retries; an unwritable record just hides us */
      }
    }
  }

  /**
   * Take back the sessions this instance published before a reload. A reload
   * starts with an empty registry, and opencode offers no way to list sessions,
   * so these records are the only evidence that a session is still running.
   * Without this an idle session stays invisible to every peer and never drains
   * its own inbox, which is what a reload used to cause.
   *
   * Only records stamped with this instance are taken, so two servers sharing a
   * spool cannot adopt each other's sessions and deliver to them twice.
   */
  reclaim(records: Owner[]): number {
    if (!this.instance) return 0
    let taken = 0
    for (const record of records) {
      if (record.instance !== this.instance || !record.session_id) continue
      if (this.live.has(record.session_id)) continue
      if (this.adopt(record.session_id, record)) taken++
    }
    return taken
  }

  /** Retire a session that no longer exists, so no message can be sent to it. */
  async retire(sessionID: string): Promise<void> {
    const peer = this.live.get(sessionID)
    if (!peer) return
    this.live.delete(sessionID)
    await this.spool.remove(this.spool.ownerPath(peer.id)).catch(() => {})
  }

  /**
   * The peer id a given session sends under.
   *
   * The event stream is per location, not per session, so one plugin instance
   * tracks every session at its location. Picking any of them stamps a message
   * with another session's id, which is why the sender is always derived from
   * the session the tool actually ran in.
   */
  idFor(sessionID: string): string | undefined {
    if (!validId(sessionID)) return undefined
    return this.live.get(sessionID)?.id ?? peerIdFor(sessionID)
  }

  nameFor(sessionID: string): string | undefined {
    if (!validId(sessionID)) return undefined
    return this.live.get(sessionID)?.name ?? nameFromPeerID(this.label, peerIdFor(sessionID))
  }

  ids(): string[] {
    return [...this.live.values()].map((peer) => peer.id)
  }

  sessions(): string[] {
    return [...this.live.keys()]
  }

  /** Presence records other hosts have refreshed inside the stale window. */
  async all(): Promise<Owner[]> {
    const now = Math.floor(Date.now() / 1000)
    return (await this.records()).filter((owner) => now - owner.last_seen <= OWNER_STALE_SECONDS)
  }

  /**
   * Every record on the spool, stale ones included. Resolution reads these so a
   * peer that has exited is answered with its age rather than as a typo.
   */
  async records(): Promise<Owner[]> {
    const peers: Owner[] = []
    for (const path of await this.spool.listJson(this.spool.ownersDir())) {
      const owner = parseOwner(await this.spool.read(path))
      if (owner) peers.push(owner)
    }
    peers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return peers
  }

  private record(peer: LivePeer): Owner {
    return {
      protocol: PROTOCOL_VERSION,
      id: peer.id,
      name: peer.name,
      started: peer.started,
      last_seen: Math.floor(Date.now() / 1000),
      status: peerStatus(peer),
      ...(peer.model ? { model: peer.model } : {}),
      ...(peer.title ? { title: peer.title } : {}),
      // The session's own directory, from the host, not a process wide guess.
      ...(peer.cwd ? { cwd: peer.cwd } : {}),
      ...(this.instance ? { instance: this.instance } : {}),
      session_id: peer.sessionID,
      origin: { host: ORIGIN_HOST },
    }
  }
}

export function newMessageId(peerID: string): string {
  return `${peerID}-${randomBytes(6).toString("hex")}`
}

/** Identifies this plugin instance across reloads. */
export function newInstanceId(): string {
  return `${ORIGIN_HOST}-${randomBytes(8).toString("hex")}`
}

/** `name [id]`, the pair every peer-facing message quotes a peer as. */
export function peerLabel(peer: Owner): string {
  return `${peer.name} [${peer.id}]`
}

/**
 * The text a receiving session is handed. Name first because that is what a
 * reader uses, id after it because that is what they copy back into a send.
 * The other host prints the same line, so both halves stay readable together.
 */
export function deliveryText(message: { from_name: string; from: string; body: string }): string {
  return `[peer ${message.from_name} ${message.from}] ${message.body}`
}

export type MarkEntry = { id: string; last_seen: number }

export type SweepReport = { marked: number; deleted: number; kept: number; unreadable: number }

/** A mark is only usable if every entry is well formed, so reject the lot. */
function parseMark(value: unknown): MarkEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: MarkEntry[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== "string" || !validId(entry.id)) return undefined
    if (typeof entry.last_seen !== "number" || !Number.isFinite(entry.last_seen)) return undefined
    entries.push({ id: entry.id, last_seen: entry.last_seen })
  }
  return entries
}

/**
 * Mark and sweep dead presence records in one pass.
 *
 * Marking writes what looks dead, sweeping deletes only what still looks dead
 * at that moment. The re-check is the point: a peer that refreshed between the
 * two phases keeps its record. Without it a sweep is a race, and losing a live
 * record is the exact failure this spool has already produced twice today.
 *
 * The mark goes through the atomic write, so a reader never sees half of one. A
 * mark file that cannot be read is left where it is rather than deleted: it is
 * either a torn write or another host's bug, and clearing it would drop a whole
 * batch on the floor for everyone.
 */
export async function sweepStaleOwners(input: {
  spool: Spool
  records: Owner[]
  ownIDs: ReadonlySet<string>
  now?: number
  horizon?: number
  markName?: string
}): Promise<SweepReport> {
  const { spool } = input
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const horizon = input.horizon ?? GC_MARK_AFTER_SECONDS
  const report: SweepReport = { marked: 0, deleted: 0, kept: 0, unreadable: 0 }
  const expired = (owner: Owner): boolean => now - owner.last_seen > horizon

  const candidates = input.records.filter((owner) => expired(owner) && !input.ownIDs.has(owner.id))
  if (candidates.length > 0) {
    const name = input.markName ?? `${process.pid}-${randomBytes(4).toString("hex")}`
    await spool.write(spool.gcMarkPath(name), candidates.map((owner) => ({ id: owner.id, last_seen: owner.last_seen })))
    report.marked = candidates.length
  }

  for (const path of await spool.listJson(spool.gcDir())) {
    const mark = parseMark(await spool.read(path))
    if (!mark) {
      report.unreadable++
      continue
    }
    for (const entry of mark) {
      const owner = parseOwner(await spool.read(spool.ownerPath(entry.id)))
      if (!owner) continue
      if (expired(owner)) {
        await spool.remove(spool.ownerPath(owner.id)).catch(() => {})
        report.deleted++
      } else {
        report.kept++
      }
    }
    await spool.remove(path).catch(() => {})
  }
  return report
}

export type ResolveResult = { peer: Owner } | { error: string }

function peerLabels(peers: Owner[]): string {
  return peers.length === 0 ? "none are registered" : peers.map(peerLabel).join(", ")
}

/**
 * Find the peer a sender meant. A name is accepted alongside an id because the
 * list a sender reads leads with one and a bare `3H0d7w` is a name fragment, not
 * an id. Resolution therefore runs before the id charset check, which names with
 * a colon would fail, and reports the alternatives instead of "not registered",
 * which reads as a peer having exited rather than as a typo.
 */
export function resolvePeer(records: Owner[], target: string, now = Math.floor(Date.now() / 1000)): ResolveResult {
  const needle = target.trim()
  if (!needle) return { error: "a peer name or id is required" }
  const lower = needle.toLowerCase()
  const live = records.filter((peer) => now - peer.last_seen <= OWNER_STALE_SECONDS)
  const dead = records.filter((peer) => now - peer.last_seen > OWNER_STALE_SECONDS)
  const rules: Array<(peer: Owner) => boolean> = [
    (peer) => peer.id === needle,
    (peer) => peer.name === needle,
    (peer) => peer.name.toLowerCase().endsWith(lower),
    (peer) => peer.id.toLowerCase().startsWith(lower),
  ]
  // A live peer wins over an exited one that matches the same fragment. Dead
  // records are considered only once nothing live does, because a test run
  // leaves hundreds behind and listing them buries the peers that are up.
  for (const matches of rules) {
    const hits = live.filter(matches)
    if (hits.length === 0) continue
    if (hits.length > 1) return { error: `"${needle}" matches ${hits.length} peers: ${peerLabels(hits)}` }
    return { peer: hits[0] }
  }
  for (const matches of rules) {
    const hits = dead.filter(matches)
    if (hits.length === 0) continue
    const newest = hits.reduce((best, peer) => (peer.last_seen > best.last_seen ? peer : best))
    const age = now - newest.last_seen
    const others = hits.length > 1 ? ` (${hits.length} exited peers match, this is the newest)` : ""
    return { error: `peer ${peerLabel(newest)} last refreshed ${age}s ago; it may have exited${others}` }
  }
  return { error: `no live peer matches "${needle}"; pass one of: ${peerLabels(live)}` }
}

/**
 * One line per peer, id first, because the id is what every send tool takes and
 * a bracketed value buried mid-line is what a reader copies by mistake. `you`
 * marks the session that asked, which `local` alone cannot: both opencode
 * sessions on one host are local, and neither knows which one is reading.
 *
 * `cwd` is the directory the host reports for this session. A host is always in
 * its own directory, so `same dir` is left off the reader: it only says
 * something about a peer.
 */
export function formatPeerLines(
  peers: Owner[],
  self: { ids: ReadonlySet<string>; cwd?: string; sessionID?: string },
): string[] {
  const mine = self.sessionID ? peerIdFor(self.sessionID) : undefined
  const lines = peers.map((peer) => {
    const flags: string[] = []
    if (mine && peer.id === mine) flags.push("you")
    if (self.ids.has(peer.id)) flags.push("local")
    if (sameTree(peer, self) && !flags.includes("you")) flags.push("same dir")
    const suffix = flags.length === 0 ? "" : `  (${flags.join(")  (")})`
    const model = peer.model ?? "-"
    const title = peer.title ?? "-"
    return `- ${peer.id}  ${peer.status}  ${model}  ${peer.name}  ${title}  via ${peer.origin?.host ?? "maki"}${suffix}`
  })
  if (peers.length <= 1) lines.push("No other local peers are registered.")
  return lines
}

export type EventData = {
  sessionID?: string
  status?: { type?: string }
  model?: { providerID?: string; id?: string }
}

function formatModel(model: EventData["model"]): string | undefined {
  if (!model?.providerID || !model.id) return undefined
  return `${model.providerID}/${model.id}`
}

/**
 * Fold one event into the registry.
 *
 * Any event carrying a session id registers that session as a peer. Relying on
 * a short list of lifecycle events is not safe: `session.created` and friends
 * are not emitted in every flow, so a peer that only appeared on those would
 * never register at all. Liveness comes from the execution events.
 */
export function applyEvent(registry: PeerRegistry, type: string, data: EventData): void {
  const sessionID = data.sessionID
  if (!sessionID) return
  registry.observe(sessionID, formatModel(data.model))
  switch (type) {
    case "session.execution.started":
      registry.setBusy(sessionID, true)
      registry.setWaiting(sessionID, false)
      break
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      registry.setBusy(sessionID, false)
      break
    case "session.status":
      if (data.status?.type === "busy") {
        registry.setBusy(sessionID, true)
        registry.setWaiting(sessionID, false)
      } else if (data.status?.type === "idle") {
        // An idle session is no longer blocked on anyone, so a retry that has
        // since resolved must stop reading as needs_input.
        registry.setBusy(sessionID, false)
        registry.setWaiting(sessionID, false)
      } else if (data.status?.type === "retry") {
        registry.setWaiting(sessionID, true)
      }
      break
    case "permission.asked":
      registry.setWaiting(sessionID, true)
      break
    case "permission.replied":
      registry.setWaiting(sessionID, false)
      break
    default:
      break
  }
}

/** A deleted session has no inbox to deliver to, so drop its presence record. */
export async function applyEventAsync(registry: PeerRegistry, type: string, data: EventData): Promise<void> {
  if (type === "session.deleted" && data.sessionID) {
    await registry.retire(data.sessionID)
    return
  }
  applyEvent(registry, type, data)
}

export function messageRecord(input: {
  id: string
  from: string
  fromName: string
  to: string
  body: string
  kind: "observation" | "status"
  session?: string
  ttlSeconds?: number
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.max(1, Math.min(Math.floor(input.ttlSeconds ?? MESSAGE_TTL_SECONDS), MESSAGE_TTL_SECONDS))
  return {
    protocol: PROTOCOL_VERSION,
    id: input.id,
    from: input.from,
    from_name: input.fromName,
    to: input.to,
    kind: input.kind,
    body: input.body,
    ...(input.session ? { session: input.session } : {}),
    origin: { host: ORIGIN_HOST },
    created: now,
    expires: now + ttl,
  }
}
