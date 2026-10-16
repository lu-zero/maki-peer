import { Plugin } from "@opencode/plugin"
import { join } from "node:path"

import { DETAIL_REFRESH_SECONDS, GC_SWEEP_INTERVAL_SECONDS, ORIGIN_HOST, OWNER_REFRESH_MS, POLL_MS, sameTree, validId, type Owner, type PeerMessage } from "./protocol.js"
import { applyEventAsync, deliveryText, formatPeerLines, messageRecord, newInstanceId, newMessageId, PeerRegistry, resolvePeer, sweepStaleOwners, type EventData } from "./peer.js"
import { encodeBody, receiveOnce, type DeliveryOutcome } from "./receive.js"
import { resolveSpoolRoot, Spool } from "./spool.js"

const TOOL_NAMESPACE = "peer"

/** One sweep per hour, counted off the poll tick so no extra timer is needed. */
const SWEEP_TICKS = Math.round((GC_SWEEP_INTERVAL_SECONDS * 1000) / POLL_MS)

/** One detail refresh per five minutes, counted off the same tick. */
const DETAIL_TICKS = Math.round((DETAIL_REFRESH_SECONDS * 1000) / POLL_MS)

const INSTANCE_SLOT = Symbol.for("maki-peer/instance")

/**
 * An id for this process's plugin instance, stable across a reload.
 *
 * It deliberately is not kept in host storage: one opencode host runs the plugin
 * in more than one process, and those processes share storage, so a stored id
 * would be the same in both. One of them would then adopt the other one's
 * sessions on reload and poll an inbox that is not its own. A per-process id
 * survives the reload it exists for and is never shared.
 */
function processInstance(): string {
  const held = globalThis as unknown as Record<symbol, unknown>
  const existing = held[INSTANCE_SLOT]
  if (typeof existing === "string" && existing !== "") return existing
  const fresh = `${ORIGIN_HOST}-${process.pid}-${newInstanceId()}`
  held[INSTANCE_SLOT] = fresh
  return fresh
}

type Options = {
  spoolRoot?: string
  /** Set false to read the spool without publishing this host's presence. */
  announce?: boolean
}

/** Tool executors receive `unknown`, so narrow the fields we rely on. */
function readArgs(input: unknown): { peer_id?: string; message?: string; session?: string; kind?: string; same_dir_only?: boolean } {
  if (typeof input !== "object" || input === null) return {}
  const record = input as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined)
  return {
    peer_id: text(record.peer_id),
    message: text(record.message),
    session: text(record.session),
    kind: text(record.kind),
    same_dir_only: record.same_dir_only === true,
  }
}

export default Plugin.define({
  id: "maki-peer",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const spool = new Spool(resolveSpoolRoot(options))
    // The directory opencode reports for this session. It has been observed to be
    // the session's own working directory rather than anything project wide.
    // No cwd here on purpose. The directory opencode reports differs between the
    // processes that host this plugin, and they all write the same record, so a
    // published directory flips between values every poll. A peer that cannot
    // name its tree reliably is better silent than wrong.
    const announce = options.announce !== false
    const instance = announce ? processInstance() : undefined
    const registry = new PeerRegistry(spool, "opencode", { instance })

    const log = (level: "info" | "warn" | "error", text: string) => {
      const line = `maki-peer: ${text}`
      if (level === "error") console.error(line)
      else if (level === "warn") console.warn(line)
      else console.log(line)
    }

    await spool.prepare()

    // A reload leaves an empty registry, so the sessions this instance had are
    // taken back from the records it wrote before.
    if (instance) {
      const reclaimed = registry.reclaim(await registry.records())
      if (reclaimed > 0) log("info", `reclaimed ${reclaimed} session(s) from a previous load`)
    }

    // adoptDetail is defined below, so the first pass is deferred a turn rather
    // than hoisted: a session reclaimed here needs its title and directory too,
    // and waiting five minutes for them is not necessary.
    void Promise.resolve().then(() => refreshDetails()).catch((error: unknown) =>
      log("error", error instanceof Error ? error.message : String(error)),
    )

    const deliver = async (message: PeerMessage, sessionID: string): Promise<DeliveryOutcome> => {
      await ctx.session.synthetic({
        sessionID: sessionID as never,
        text: deliveryText(message),
        description: message.kind === "status" ? "peer status" : "peer observation",
        metadata: { makiPeer: { from: message.from, kind: message.kind } },
        delivery: "steer",
        resume: true,
      })
      return "delivered"
    }

    const adoptDetail = async (sessionID: string): Promise<void> => {
      const info = await ctx.session.get({ sessionID })
      registry.setDetail(sessionID, { title: info.title, cwd: info.location?.directory })
    }

    /** Refresh what the host knows about sessions the registry already holds. */
    const refreshDetails = async (): Promise<void> => {
      for (const sessionID of registry.sessions()) {
        await adoptDetail(sessionID).catch((error: unknown) =>
          log("warn", `could not read session detail: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
    }

    const runSweep = async (): Promise<void> => {
      if (!announce) return
      const report = await sweepStaleOwners({
        spool,
        records: await registry.records(),
        ownIDs: new Set(registry.ids()),
      })
      if (report.deleted + report.marked + report.unreadable === 0) return
      log(
        "info",
        `swept ${report.deleted} owner record(s), kept ${report.kept}, unreadable mark(s) ${report.unreadable}`,
      )
    }

    let ticks = 0
    let detailTicks = 0
    let polling = false
    const poll = async () => {
      // Delivering into a busy session can outlive the 500ms tick, and a second
      // poll started while the first was still reading would deliver the same
      // inbox twice: receiveOnce reads every pending file before it delivers
      // the first one. One poller at a time per process; the tick that finds a
      // poll in flight simply waits for the next.
      if (polling) return
      polling = true
      try {
        await pollOnce()
      } finally {
        polling = false
      }
    }

    const pollOnce = async () => {
      if (announce) await registry.flush(OWNER_REFRESH_MS)
      for (const sessionID of registry.sessions()) {
        const peer = registry.get(sessionID)
        if (!peer) continue
        const report = await receiveOnce({
          spool,
          peerID: peer.id,
          instance: processInstance(),
          addressing: { ownSession: sessionID, owns: (id) => registry.has(id) },
          deliver,
          onDrop: (message, reason) => log("warn", `dropped ${message.id}: ${reason}`),
        })
        if (report.overflow > 0) log("warn", `${report.overflow} messages waited behind the inbox cap this cycle`)
      }
      // Titles and directories change without an event, and a session observed
      // before this load never sees the per session read at all, so refresh on
      // a slow count of this tick rather than only on first sight.
      if (++detailTicks >= DETAIL_TICKS) {
        detailTicks = 0
        await refreshDetails().catch((error: unknown) =>
          log("error", error instanceof Error ? error.message : String(error)),
        )
      }
      // Mark and sweep share the poll tick rather than adding a timer, and run
      // hourly. Delivery never waits on this: it is wrapped so a sweep that
      // fails cannot stop a peer receiving its messages.
      if (++ticks >= SWEEP_TICKS) {
        ticks = 0
        void runSweep().catch((error: unknown) => log("error", error instanceof Error ? error.message : String(error)))
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
          const data = event.data as EventData
          const known = data.sessionID ? registry.has(data.sessionID) : false
          await applyEventAsync(registry, event.type, data)
          // A session the plugin has just learned about gets one read to pick up
          // its title and its own directory. The event stream carries neither.
          if (data.sessionID && !known && registry.has(data.sessionID)) await adoptDetail(data.sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          log("error", `event stream ended: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()

    const self = (): { ids: Set<string>; cwd?: string } => ({ ids: new Set(registry.ids()) })

    const listOutput = async (sessionID?: string): Promise<string> =>
      formatPeerLines(await registry.all(), { ...self(), sessionID }).join("\n")

    /** Broadcast targets, resolved in one pass instead of rescanning per peer. */
    /**
 * The peer id of the session that asked, and only that one. A host tracks every
 * session at its location, so "self" cannot be the registry: two sessions of one
 * server are different agents, and they talk to each other all day. Excluding
 * the whole host from a send would make that impossible.
 */
const ownID = (sessionID?: string): string[] => {
  const id = sessionID ? registry.idFor(sessionID) : undefined
  return id ? [id] : []
}

const broadcastTargets = async (fromSessionID: string | undefined, sameDirOnly: boolean): Promise<Owner[]> => {
  const mine = ownID(fromSessionID)
  const peers = await registry.all()
  return peers.filter((peer) => !mine.includes(peer.id) && (!sameDirOnly || sameTree(peer, self())))
}

    const queue = async (
      target: Owner,
      body: unknown,
      kind: "observation" | "status",
      fromSessionID: string,
      session?: string,
    ): Promise<{ id: string; peer: string } | { error: string }> => {
      const encoded = encodeBody(body)
      if (encoded === undefined) return { error: "message body is blank or too large" }
      const fromID = registry.idFor(fromSessionID) ?? `${ORIGIN_HOST}-${process.pid}`
      const id = newMessageId(fromID)
      await spool.ensureInbox(target.id)
      // A session id only means something on the host that minted it, so it is
      // only written when the receiver is this host and could act on it.
      const sameHost = (target.origin?.host ?? "maki") === ORIGIN_HOST
      await spool.write(
        join(spool.inboxPath(target.id), `${id}.json`),
        messageRecord({
          id,
          from: fromID,
          fromName: registry.nameFor(fromSessionID) ?? "opencode",
          to: target.id,
          body: encoded,
          kind,
          ...(sameHost && session ? { session } : {}),
        }),
      )
      return { id, peer: target.id }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: TOOL_NAMESPACE, description: "Local host-to-host observation messaging" })
      editor.add({
        name: "list",
        description: "List local Maki and OpenCode instances registered on this machine.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => ({ content: await listOutput(context.sessionID) }),
      })
      editor.add({
        name: "send",
        description: "Send an observation or status to another local Maki or OpenCode instance.",
        input: {
          type: "object",
          properties: {
            peer_id: { type: "string", description: "Target peer id or name, as printed by peer_list" },
            message: { type: "string", description: "Observation to deliver" },
            session: { type: "string", description: "Optional session id on the receiving host" },
            kind: { type: "string", enum: ["observation", "status"] },
          },
          required: ["peer_id", "message"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = readArgs(input)
          if (!args.peer_id) throw new Error("peer_id is required")
          if (!args.message) throw new Error("message is required")
          const kind = args.kind === "status" ? "status" : "observation"
          const resolved = resolvePeer(await registry.records(), args.peer_id, undefined, ownID(context.sessionID))
          if ("error" in resolved) throw new Error(resolved.error)
          const result = await queue(resolved.peer, args.message, kind, context.sessionID, args.session)
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
            same_dir_only: {
              type: "boolean",
              description: "Only peers reporting the same directory, where this host reports one",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = readArgs(input)
          if (!args.message) throw new Error("message is required")
          const kind = args.kind === "status" ? "status" : "observation"
          const sameDirOnly = args.same_dir_only === true
          const targets = await broadcastTargets(context.sessionID, sameDirOnly)
          let queued = 0
          for (const peer of targets) {
            const result = await queue(peer, args.message, kind, context.sessionID, args.session)
            if (!("error" in result)) queued++
          }
          if (queued === 0 && sameDirOnly) {
            return { content: "Queued 0 peer messages. This host reports no directory, so same_dir_only matched no peer." }
          }
          return { content: `Queued ${queued} peer messages.` }
        },
      })
    })

    // No /peer command on this host, deliberately. A plugin command has one
    // output channel, session.prompt, which is a model turn, so a read only
    // listing cost a turn and invited the model to act on it. The tools are the
    // surface for the model, and a command comes back when upstream lets a
    // command answer without one: anomalyco/opencode#28292.

    return () => {
      clearInterval(timer)
      controller.abort()
      // Records are deliberately left on the spool. This runs on every reload,
      // and erasing here is what made a live session vanish from every peer
      // list. A host that really exits goes stale on its own.
    }
  },
})
