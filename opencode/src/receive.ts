import { MAX_BODY_BYTES, MAX_INBOX, originHost, parseMessage, type PeerMessage } from "./protocol.js"
import { Spool } from "./spool.js"

export type DeliveryOutcome = "delivered" | "dead" | "retry"

export type Deliver = (message: PeerMessage, sessionID: string) => Promise<DeliveryOutcome>

export type ReceiveReport = {
  delivered: number
  dropped: number
  retried: number
  overflow: number
}

export type Addressing = {
  /** The session this peer represents, and the fallback for foreign addresses. */
  ownSession: string
  /** Whether a session id minted by this host still exists. */
  owns: (sessionID: string) => boolean
}

/**
 * A session id only means something on the host that minted it. An address from
 * another host cannot name a session here, so it is ignored in favour of the
 * owning peer. An address from our own host that we do not recognise belongs to
 * a session that is gone, and no later tick can deliver it, so it resolves to
 * undefined and the message is dropped.
 */
export function addressFor(message: PeerMessage, addressing: Addressing): string | undefined {
  if (originHost(message) !== "opencode") return addressing.ownSession
  if (!message.session) return addressing.ownSession
  return addressing.owns(message.session) ? message.session : undefined
}

export function encodeBody(body: unknown): string | undefined {
  if (typeof body === "string") {
    if (body.trim() === "") return undefined
    return body.length > MAX_BODY_BYTES ? undefined : body
  }
  const encoded = JSON.stringify(body ?? null)
  return Buffer.byteLength(encoded) > MAX_BODY_BYTES ? undefined : encoded
}

export async function receiveOnce(input: {
  spool: Spool
  peerID: string
  addressing: Addressing
  deliver: Deliver
  onDrop?: (message: PeerMessage, reason: string) => void
}): Promise<ReceiveReport> {
  const { spool, peerID, deliver } = input
  const report: ReceiveReport = { delivered: 0, dropped: 0, retried: 0, overflow: 0 }
  await spool.ensureInbox(peerID)

  const now = Math.floor(Date.now() / 1000)
  const pending: { path: string; value: PeerMessage }[] = []
  for (const path of await spool.listJson(spool.inboxPath(peerID))) {
    const message = parseMessage(await spool.read(path), peerID)
    if (!message) continue
    if (message.expires <= now) {
      await spool.remove(path).catch(() => {})
      report.dropped++
      input.onDrop?.(message, "expired")
      continue
    }
    pending.push({ path, value: message })
  }
  pending.sort((a, b) => a.value.created - b.value.created)

  report.overflow = Math.max(0, pending.length - MAX_INBOX)
  for (const item of pending.slice(0, MAX_INBOX)) {
    const target = addressFor(item.value, input.addressing)
    if (!target) {
      await spool.remove(item.path).catch(() => {})
      report.dropped++
      input.onDrop?.(item.value, "addressed a session this host no longer runs")
      continue
    }
    let outcome: DeliveryOutcome
    try {
      outcome = await deliver(item.value, target)
    } catch (error) {
      outcome = "retry"
      input.onDrop?.(item.value, error instanceof Error ? error.message : String(error))
    }
    if (outcome === "delivered") {
      await spool.remove(item.path).catch(() => {})
      report.delivered++
    } else if (outcome === "dead") {
      await spool.remove(item.path).catch(() => {})
      report.dropped++
    } else {
      report.retried++
    }
  }
  return report
}
