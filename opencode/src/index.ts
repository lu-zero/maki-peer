import { Plugin } from "@opencode/plugin"
import { join } from "node:path"

import { ORIGIN_HOST, OWNER_REFRESH_MS, POLL_MS, validId, type PeerMessage } from "./protocol.js"
import { applyEventAsync, messageRecord, newMessageId, PeerRegistry, type EventData } from "./peer.js"
import { encodeBody, receiveOnce, type DeliveryOutcome } from "./receive.js"
import { resolveSpoolRoot, Spool } from "./spool.js"

const TOOL_NAMESPACE = "peer"

type Options = {
  spoolRoot?: string
  /** Set false to read the spool without publishing this host's presence. */
  announce?: boolean
}

/** Tool executors receive `unknown`, so narrow the fields we rely on. */
function readArgs(input: unknown): { peer_id?: string; message?: string; session?: string; kind?: string } {
  if (typeof input !== "object" || input === null) return {}
  const record = input as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined)
  return {
    peer_id: text(record.peer_id),
    message: text(record.message),
    session: text(record.session),
    kind: text(record.kind),
  }
}

export default Plugin.define({
  id: "maki-peer",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const spool = new Spool(resolveSpoolRoot(options))
    const registry = new PeerRegistry(spool)
    const announce = options.announce !== false

    const log = (level: "info" | "warn" | "error", text: string) => {
      const line = `maki-peer: ${text}`
      if (level === "error") console.error(line)
      else if (level === "warn") console.warn(line)
      else console.log(line)
    }

    await spool.prepare()

    const deliver = async (message: PeerMessage, sessionID: string): Promise<DeliveryOutcome> => {
      await ctx.session.synthetic({
        sessionID: sessionID as never,
        text: `[peer ${message.from}] ${message.body}`,
        description: message.kind === "status" ? "peer status" : "peer observation",
        metadata: { makiPeer: { from: message.from, kind: message.kind } },
        delivery: "steer",
        resume: true,
      })
      return "delivered"
    }

    const poll = async () => {
      if (announce) await registry.flush(OWNER_REFRESH_MS)
      for (const sessionID of registry.sessions()) {
        const peer = registry.get(sessionID)
        if (!peer) continue
        const report = await receiveOnce({
          spool,
          peerID: peer.id,
          addressing: { ownSession: sessionID, owns: (id) => registry.has(id) },
          deliver,
          onDrop: (message, reason) => log("warn", `dropped ${message.id}: ${reason}`),
        })
        if (report.overflow > 0) log("warn", `${report.overflow} messages waited behind the inbox cap this cycle`)
      }
    }

    const timer = setInterval(() => {
      void poll().catch((error: unknown) => log("error", error instanceof Error ? error.message : String(error)))
    }, POLL_MS)
    timer.unref?.()

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await applyEventAsync(registry, event.type, event.data as EventData)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          log("error", `event stream ended: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()

    const listOutput = async (): Promise<string> => {
      const mine = new Set(registry.ids())
      const lines = (await registry.all()).map((peer) => {
        const host = peer.origin?.host ?? "maki"
        const local = mine.has(peer.id) ? " (local)" : ""
        return `- ${peer.name} [${peer.id}] ${peer.status}${peer.model ? ` ${peer.model}` : ""} via ${host}${local}`
      })
      return lines.length === 0 ? "No local hosts are registered." : lines.join("\n")
    }

    const queue = async (
      target: string,
      body: unknown,
      kind: "observation" | "status",
      session?: string,
    ): Promise<{ id: string; peer: string } | { error: string }> => {
      if (!validId(target)) return { error: "invalid peer id" }
      const encoded = encodeBody(body)
      if (encoded === undefined) return { error: "message body is blank or too large" }
      const owner = (await registry.all()).find((candidate) => candidate.id === target)
      if (!owner) return { error: "peer is not registered or is offline" }
      const from = registry.sender()
      const fromID = from?.id ?? `${ORIGIN_HOST}-${process.pid}`
      const id = newMessageId(fromID)
      await spool.ensureInbox(target)
      // A session id only means something on the host that minted it, so it is
      // only written when the receiver is this host and could act on it.
      const sameHost = (owner.origin?.host ?? "maki") === ORIGIN_HOST
      await spool.write(
        join(spool.inboxPath(target), `${id}.json`),
        messageRecord({
          id,
          from: fromID,
          fromName: from?.name ?? "opencode",
          to: target,
          body: encoded,
          kind,
          ...(sameHost && session ? { session } : {}),
        }),
      )
      return { id, peer: target }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: TOOL_NAMESPACE, description: "Local host-to-host observation messaging" })
      editor.add({
        name: "list",
        description: "List local Maki and OpenCode instances registered on this machine.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await listOutput() }),
      })
      editor.add({
        name: "send",
        description: "Send an observation or status to another local Maki or OpenCode instance.",
        input: {
          type: "object",
          properties: {
            peer_id: { type: "string", description: "Target peer id" },
            message: { type: "string", description: "Observation to deliver" },
            session: { type: "string", description: "Optional session id on the receiving host" },
            kind: { type: "string", enum: ["observation", "status"] },
          },
          required: ["peer_id", "message"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = readArgs(input)
          if (!args.peer_id) throw new Error("peer_id is required")
          if (!args.message) throw new Error("message is required")
          const result = await queue(args.peer_id, args.message, args.kind === "status" ? "status" : "observation", args.session)
          if ("error" in result) throw new Error(result.error)
          return { content: `Queued peer message ${result.id} for ${result.peer}.` }
        },
      })
      editor.add({
        name: "broadcast",
        description: "Send one observation to every active local Maki and OpenCode instance.",
        input: {
          type: "object",
          properties: {
            message: { type: "string", description: "Observation to deliver" },
            session: { type: "string", description: "Optional session id on the receiving host" },
            kind: { type: "string", enum: ["observation", "status"] },
          },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = readArgs(input)
          if (!args.message) throw new Error("message is required")
          const kind = args.kind === "status" ? "status" : "observation"
          const mine = new Set(registry.ids())
          const targets = (await registry.all()).filter((peer) => !mine.has(peer.id))
          let queued = 0
          for (const peer of targets) {
            if (!("error" in (await queue(peer.id, args.message as string, kind, args.session)))) queued++
          }
          return { content: `Queued ${queued} peer messages.` }
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "peer",
        description: "List local Maki and OpenCode peers, or send one a message",
        execute: async ({ sessionID, prompt, delivery }) => {
          const args = prompt.text.trim()
          const reply = (text: string) => ctx.session.prompt({ sessionID, text, delivery })
          if (!args.startsWith("send ")) {
            await reply(await listOutput())
            return
          }
          const rest = args.slice(5).trim()
          const cut = rest.search(/\s/)
          if (cut < 0) {
            await reply("Usage: /peer send <peer-id> <message>")
            return
          }
          const peerID = rest.slice(0, cut)
          const result = await queue(peerID, rest.slice(cut).trim(), "observation")
          await reply("error" in result ? `Could not send peer message: ${result.error}` : `Queued peer message ${result.id} for ${result.peer}.`)
        },
      })
    })

    return () => {
      clearInterval(timer)
      controller.abort()
      registry.retireAllSync()
    }
  },
})
