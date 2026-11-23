import { join } from "node:path"

import { messageRecord, newMessageId } from "./peer.js"
import { ORIGIN_HOST, type Owner } from "./protocol.js"
import type { Spool } from "./spool.js"

/** Write one observation to a peer's inbox. Mirrors the server's queue path. */
export async function queuePeerMessage(
  spool: Spool,
  target: Owner,
  body: string,
  from: { id: string; name: string },
  session?: string,
): Promise<string> {
  const id = newMessageId(from.id)
  const sameHost = (target.origin?.host ?? "maki") === ORIGIN_HOST
  await spool.write(
    join(spool.inboxPath(target.id), `${id}.json`),
    messageRecord({
      id,
      from: from.id,
      fromName: from.name,
      to: target.id,
      body,
      kind: "observation",
      ...(sameHost && session ? { session } : {}),
    }),
  )
  return id
}
