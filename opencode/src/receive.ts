import {
  CLAIM_TIMEOUT_SECONDS,
  MAX_BODY_BYTES,
  MAX_INBOX,
  originHost,
  parseMessage,
  type PeerMessage,
} from "./protocol.js"
import { Spool } from "./spool.js"

export type DeliveryOutcome = "delivered" | "dead" | "retry"

export type Deliver = (message: PeerMessage, sessionID: string) => Promise<DeliveryOutcome>

export type ReceiveReport = {
  delivered: number
  dropped: number
  retried: number
  overflow: number
  /** Messages another poller had already claimed, left for it. */
  taken: number
  /** Abandoned claims put back in the queue. */
  recovered: number
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

const CLAIM_SUFFIX = ".claim"

/** `m1.json.opencode-123-abc.claim` came from `m1.json`. */
function originalPath(claimPath: string): string {
  const withoutSuffix = claimPath.slice(0, -CLAIM_SUFFIX.length)
  const cut = withoutSuffix.lastIndexOf(".")
  return cut > 0 ? withoutSuffix.slice(0, cut) : withoutSuffix
}

/**
 * Take a message out of the queue before reading it.
 *
 * Rename is atomic, so exactly one poller wins a given file and the loser never
 * sees it. That is what stops two hosts that legitimately track the same session
 * from delivering it twice, which per-process serialisation cannot fix because
 * the two pollers sit in different processes. The suffix stays off `.json`, so
 * neither half's listing, nor the other host, treats a claim as a message.
 */
async function claim(spool: Spool, path: string, instance: string): Promise<string | undefined> {
  const claimPath = `${path}.${instance}${CLAIM_SUFFIX}`
  const won = await spool.rename(path, claimPath).then(
    () => true,
    () => false,
  )
  return won ? claimPath : undefined
}

/**
 * Put a message back in the queue. A delivery that asked to retry goes back, and
 * so does a claim too old to still be held. Back in the queue means any poller
 * may take it, which is how at-least-once survives both a crash and a slow
 * delivery.
 */
async function unclaim(spool: Spool, claimPath: string): Promise<void> {
  await spool.rename(claimPath, originalPath(claimPath)).catch(() => {})
}

/**
 * Claims left behind by a poller that died mid delivery go back to the queue
 * once they are older than any live delivery could hold them. Until then they
 * are left strictly alone: stealing a fresh claim would undo the exclusivity
 * that is the reason claims exist.
 */
async function recoverAbandoned(input: {
  spool: Spool
  inboxDir: string
  nowMs: number
}): Promise<number> {
  let recovered = 0
  for (const path of await input.spool.listFiles(input.inboxDir)) {
    if (!path.endsWith(CLAIM_SUFFIX)) continue
    const info = await input.spool.stat(path)
    if (info && input.nowMs - info.mtimeMs < CLAIM_TIMEOUT_SECONDS * 1000) continue
    await unclaim(input.spool, path)
    recovered++
  }
  return recovered
}

export async function receiveOnce(input: {
  spool: Spool
  peerID: string
  /** Who is polling, so a claim names the process that holds it. */
  instance?: string
  addressing: Addressing
  deliver: Deliver
  onDrop?: (message: PeerMessage, reason: string) => void
}): Promise<ReceiveReport> {
  const { spool, peerID, deliver } = input
  const instance = input.instance ?? "receive-once"
  const report: ReceiveReport = { delivered: 0, dropped: 0, retried: 0, overflow: 0, taken: 0, recovered: 0 }
  const inboxDir = spool.inboxPath(peerID)
  await spool.ensureInbox(peerID)
  const nowMs = Date.now()

  report.recovered = await recoverAbandoned({ spool, inboxDir, nowMs })

  const now = Math.floor(nowMs / 1000)
  const pending: { path: string; claimPath: string; value: PeerMessage }[] = []
  for (const path of await spool.listJson(inboxDir)) {
    const claimPath = await claim(spool, path, instance)
    if (!claimPath) {
      report.taken++
      continue
    }
    const message = parseMessage(await spool.read(claimPath), peerID)
    if (!message) {
      // Unparsable cannot go back to the queue, where it would be claimed and
      // rejected every pass forever, so it is dropped and counted.
      await spool.remove(claimPath).catch(() => {})
      report.dropped++
      continue
    }
    if (message.expires <= now) {
      await spool.remove(claimPath).catch(() => {})
      report.dropped++
      input.onDrop?.(message, "expired")
      continue
    }
    pending.push({ path, claimPath, value: message })
  }
  pending.sort((a, b) => a.value.created - b.value.created)

  report.overflow = Math.max(0, pending.length - MAX_INBOX)
  for (const item of pending.slice(0, MAX_INBOX)) {
    const target = addressFor(item.value, input.addressing)
    if (!target) {
      await spool.remove(item.claimPath).catch(() => {})
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
      await spool.remove(item.claimPath).catch(() => {})
      report.delivered++
    } else if (outcome === "dead") {
      await spool.remove(item.claimPath).catch(() => {})
      report.dropped++
    } else {
      await unclaim(spool, item.claimPath)
      report.retried++
    }
  }
  return report
}
