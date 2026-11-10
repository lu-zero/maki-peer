import { deliveryText } from "./shared/peer.ts"
import { receiveOnce } from "./shared/receive.ts"
import { Spool } from "./shared/spool.ts"
import { MAX_DELIVERY_CHARS, ORIGIN_HOST } from "./identity.ts"
import { peerIdOf } from "./presence.ts"

/**
 * Claim this session's inbox and return the hook stdout that carries it.
 *
 * The pre_agent and post_tool hooks return it as `additional_context`; either
 * may claim. Empty means there was nothing to add. post_agent cannot carry
 * this text: its stdout can only accept the turn or ask for a retry.
 */
export async function takeMail(spool: Spool, sessionId: string): Promise<string> {
  const lines: string[] = []
  await receiveOnce({
    spool,
    peerID: peerIdOf(sessionId),
    instance: `vibe-${process.pid}`,
    host: ORIGIN_HOST,
    addressing: {
      ownSession: sessionId,
      owns: (id) => id === sessionId,
    },
    deliver: async (message) => {
      lines.push(deliveryText(message))
      return "delivered"
    },
  })
  if (lines.length === 0) return ""
  let text = lines.join("\n")
  if (text.length > MAX_DELIVERY_CHARS) text = `${text.slice(0, MAX_DELIVERY_CHARS)}\n[truncated]`
  return JSON.stringify({ hook_specific_output: { additional_context: text } })
}
