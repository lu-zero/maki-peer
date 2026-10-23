import { join } from "node:path"

import {
  broadcastTo,
  formatPeerLines,
  messageRecord,
  newMessageId,
  PeerRegistry,
  resolvePeer,
} from "./shared/peer.ts"
import { kindOf, sameTree, type Owner } from "./shared/protocol.ts"
import { encodeBody } from "./shared/receive.ts"
import { Spool } from "./shared/spool.ts"
import { actingSession, LABEL, ORIGIN_HOST, peerIdOf, peerNameOf, type SessionState } from "./state.ts"

export type ToolResult = { text: string; error: boolean }

function isState(value: SessionState | { error: string }): value is SessionState {
  return !("error" in value)
}

async function livePeers(spool: Spool): Promise<Owner[]> {
  return new PeerRegistry(spool, LABEL, { idPrefix: "gk", host: ORIGIN_HOST }).all()
}

export async function peerList(spool: Spool, self: SessionState | undefined): Promise<ToolResult> {
  const peers = await livePeers(spool)
  const lines = formatPeerLines(peers, {
    ids: new Set(self ? [peerIdOf(self.sessionId)] : []),
    ...(self?.cwd ? { cwd: self.cwd } : {}),
    ...(self ? { sessionID: self.sessionId, idPrefix: "gk" as const } : {}),
  })
  return { text: lines.join("\n"), error: false }
}

async function queue(
  spool: Spool,
  self: SessionState,
  target: Owner,
  body: string,
  kind: "observation" | "status",
  session: string | undefined,
  topic: string | undefined,
): Promise<{ id: string; peer: string } | { error: string }> {
  const encoded = encodeBody(body)
  if (encoded === undefined) return { error: "message body is blank or too large" }
  const from = peerIdOf(self.sessionId)
  const id = newMessageId(from)
  await spool.ensureInbox(target.id)
  const sameHost = (target.origin?.host ?? "maki") === ORIGIN_HOST
  await spool.write(
    join(spool.inboxPath(target.id), `${id}.json`),
    messageRecord({
      id,
      from,
      fromName: peerNameOf(self.sessionId),
      to: target.id,
      body: encoded,
      kind,
      ...(topic ? { topic } : {}),
      ...(sameHost && session ? { session } : {}),
      host: ORIGIN_HOST,
    }),
  )
  return { id, peer: target.id }
}

export async function peerSend(
  spool: Spool,
  self: SessionState,
  args: { peer_id?: string; message?: string; topic?: string; session?: string; kind?: string },
): Promise<ToolResult> {
  if (!args.peer_id) return { text: "peer_id is required", error: true }
  if (!args.message) return { text: "message is required", error: true }
  let kind: "observation" | "status"
  try {
    kind = kindOf(args.kind)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), error: true }
  }
  const records = await new PeerRegistry(spool, LABEL).records()
  const resolved = resolvePeer(records, args.peer_id, undefined, [peerIdOf(self.sessionId)])
  if ("error" in resolved) return { text: resolved.error, error: true }
  const result = await queue(spool, self, resolved.peer, args.message, kind, args.session, args.topic)
  if ("error" in result) return { text: result.error, error: true }
  return { text: `Queued peer message ${result.id} for ${result.peer}.`, error: false }
}

export async function peerBroadcast(
  spool: Spool,
  self: SessionState,
  args: { message?: string; topic?: string; session?: string; kind?: string; same_dir_only?: boolean },
): Promise<ToolResult> {
  if (!args.message) return { text: "message is required", error: true }
  let kind: "observation" | "status"
  try {
    kind = kindOf(args.kind)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), error: true }
  }
  const mine = peerIdOf(self.sessionId)
  const peers = await livePeers(spool)
  const cwd = args.same_dir_only ? self.cwd : undefined
  const targets = peers.filter((peer) => peer.id !== mine && (!args.same_dir_only || sameTree(peer, { cwd })))
  const queued = await broadcastTo(targets, (peer) => queue(spool, self, peer, args.message ?? "", kind, args.session, args.topic))
  return { text: `Queued ${queued} peer messages.`, error: false }
}

export async function callTool(
  spool: Spool,
  runtime: string,
  hint: { pid: number; sessionId?: string },
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  await spool.prepare()
  const textArg = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined)
  const fields = {
    peer_id: textArg(args.peer_id),
    message: textArg(args.message),
    topic: textArg(args.topic),
    session: textArg(args.session),
    kind: textArg(args.kind),
    same_dir_only: args.same_dir_only === true,
  }
  if (name === "peer_list") {
    const actor = await actingSession(runtime, hint)
    return peerList(spool, isState(actor) ? actor : undefined)
  }
  const actor = await actingSession(runtime, hint)
  if (!isState(actor)) return { text: actor.error, error: true }
  if (name === "peer_send") return peerSend(spool, actor, fields)
  if (name === "peer_broadcast") return peerBroadcast(spool, actor, fields)
  return { text: `unknown tool ${name}`, error: true }
}
