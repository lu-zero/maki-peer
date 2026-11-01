import { peerIdFor, PeerRegistry } from "./shared/peer.ts"
import { validId } from "./shared/protocol.ts"
import { Spool } from "./shared/spool.ts"
import { ID_PREFIX, LABEL, ORIGIN_HOST } from "./identity.ts"
import type { SessionState } from "./state.ts"

export function peerIdOf(sessionId: string): string {
  return peerIdFor(sessionId, ID_PREFIX)
}

/** Write the presence record. The inbox stays, so a resume can still be addressed. */
export async function publish(spool: Spool, state: SessionState): Promise<void> {
  await spool.prepare()
  const registry = new PeerRegistry(spool, LABEL, {
    instance: `vibe-${process.pid}`,
    idPrefix: ID_PREFIX,
    host: ORIGIN_HOST,
  })
  const peer = registry.observe(state.sessionId)
  if (!peer) return
  peer.started = state.started
  registry.setBusy(state.sessionId, state.busy)
  registry.setWaiting(state.sessionId, false)
  if (state.cwd) registry.setDetail(state.sessionId, { cwd: state.cwd })
  await registry.flush(0)
}

export async function unpublish(spool: Spool, sessionId: string): Promise<void> {
  if (!validId(sessionId)) return
  await spool.remove(spool.ownerPath(peerIdOf(sessionId)))
}
