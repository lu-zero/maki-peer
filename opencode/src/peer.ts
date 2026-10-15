import { createHash, randomBytes } from "node:crypto"

import {
  MESSAGE_TTL_SECONDS,
  ORIGIN_HOST,
  OWNER_STALE_SECONDS,
  PROTOCOL_VERSION,
  parseOwner,
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
  dirty: boolean
  lastWrite: number
}

export function peerStatus(peer: LivePeer): PeerStatus {
  return statusFor({ busy: peer.busy, waiting: peer.waiting })
}

export class PeerRegistry {
  private readonly live = new Map<string, LivePeer>()
  private readonly spool: Spool
  private readonly label: string

  constructor(spool: Spool, label = "opencode") {
    this.spool = spool
    this.label = label
  }

  observe(sessionID: string, model?: string): LivePeer | undefined {
    if (!validId(sessionID)) return undefined
    const existing = this.live.get(sessionID)
    if (existing) {
      this.setModel(sessionID, model)
      return existing
    }
    const peer: LivePeer = {
      sessionID,
      id: peerIdFor(sessionID),
      name: `${this.label}:${sessionID.slice(-6)}`,
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

  async retire(sessionID: string): Promise<void> {
    const peer = this.live.get(sessionID)
    if (!peer) return
    this.live.delete(sessionID)
    await this.spool.remove(this.spool.ownerPath(peer.id)).catch(() => {})
  }

  /** Retire every session. Used on teardown, where awaiting is not possible. */
  retireAllSync(): void {
    for (const peer of this.live.values()) this.spool.removeSync(this.spool.ownerPath(peer.id))
    this.live.clear()
  }

  /** One peer to send as, preferring a session that is not already busy. */
  sender(): LivePeer | undefined {
    const peers = [...this.live.values()]
    return peers.find((peer) => !peer.busy) ?? peers[0]
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
    const peers: Owner[] = []
    for (const path of await this.spool.listJson(this.spool.ownersDir())) {
      const owner = parseOwner(await this.spool.read(path))
      if (owner && now - owner.last_seen <= OWNER_STALE_SECONDS) peers.push(owner)
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
      origin: { host: ORIGIN_HOST },
    }
  }
}

export function newMessageId(peerID: string): string {
  return `${peerID}-${randomBytes(6).toString("hex")}`
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
