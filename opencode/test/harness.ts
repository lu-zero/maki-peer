import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PeerRegistry } from "../src/peer.js"
import { receiveOnce, type DeliveryOutcome } from "../src/receive.js"
import { Spool } from "../src/spool.js"
import type { PeerMessage } from "../src/protocol.js"

export type Delivered = { sessionID: string; text: string }

export type FakeHost = {
  spool: Spool
  registry: PeerRegistry
  delivered: Delivered[]
  peerID: string
  /** When set, replaces the delivery outcome, for retry and dead paths. */
  deliverOverride?: () => DeliveryOutcome
  pump: () => Promise<void>
}

/**
 * The parts of an opencode host the spool layer actually depends on. A real
 * host gets these from `ctx.session` and the event stream, so exercising this
 * covers every path between a spool file and a delivered session message.
 */
export function fakeHost(root: string, label: string, sessionID: string): FakeHost {
  const spool = new Spool(root)
  const registry = new PeerRegistry(spool, label)
  const delivered: Delivered[] = []
  const peerID = registry.observe(sessionID)?.id as string
  const host: FakeHost = {
    spool,
    registry,
    delivered,
    peerID,
    async pump() {
      await spool.prepare()
      await registry.flush(0)
      await receiveOnce({
        spool,
        peerID,
        instance: "test",
        addressing: { ownSession: sessionID, owns: (id) => registry.has(id) },
        deliver: async (message: PeerMessage, target: string): Promise<DeliveryOutcome> => {
          if (host.deliverOverride) return host.deliverOverride()
          delivered.push({ sessionID: target, text: `[peer ${message.from}] ${message.body}` })
          return "delivered"
        },
      })
    },
  }
  return host
}

/** Write a spool record by hand, the way the other host would. */
export function writeRecord(root: string, peerID: string, record: Record<string, unknown>): string {
  const dir = join(root, "inboxes", peerID)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${String(record.id)}.json`)
  writeFileSync(path, JSON.stringify(record))
  return path
}

/** A record shaped the way maki's `queue_message` writes one. */
export function makiRecord(input: {
  id: string
  from: string
  to: string
  body: string
  session?: string
  origin?: string
  ttl?: number
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    protocol: 1,
    id: input.id,
    from: input.from,
    from_name: "maki-peer",
    to: input.to,
    kind: "observation",
    body: input.body,
    ...(input.session ? { session: input.session } : {}),
    ...(input.origin ? { origin: { host: input.origin } } : {}),
    created: now,
    expires: now + (input.ttl ?? 300),
  }
}

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "maki-peer-"))
}

export function inbox(root: string, peerID: string): string[] {
  try {
    return readdirSync(join(root, "inboxes", peerID))
  } catch {
    return []
  }
}

export function owners(root: string): string[] {
  try {
    return readdirSync(join(root, "owners"))
  } catch {
    return []
  }
}
