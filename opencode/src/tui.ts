import { Plugin } from "@opencode/plugin/tui"

import { PeerRegistry } from "./peer.js"
import type { SpoolOptions } from "./spool.js"
import { resolveSpoolRoot, Spool } from "./spool.js"
import { peerOptions, shortID } from "./tuiList.js"
import { queuePeerMessage } from "./tuiSend.js"

/**
 * The TUI half of the plugin. It owns the slash command only: the server half
 * publishes presence and answers the peer tools. A command run here stays in
 * the client, so /peer shows a dialog without starting a model turn.
 */
export default Plugin.define({
  id: "maki-peer.tui",
  setup(ctx) {
    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "maki-peer.peer",
          title: "List peers",
          palette: true,
          slash: { name: "peer", arguments: true },
          run: async () => {
            const spool = new Spool(resolveSpoolRoot(ctx.options as SpoolOptions))
            const registry = new PeerRegistry(spool, "opencode")
            const route = ctx.ui.router.current()
            const sessionID = route.type === "session" ? route.sessionID : undefined
            const peers = await registry.all()
            const ownID = sessionID ? registry.idFor(sessionID) : undefined
            let sized = false
            const selected = await ctx.ui.dialog.select({
              title: [
                `${peers.length} peers: ${peers.filter((peer) => peer.status !== "idle").length} active, ${peers.filter((peer) => peer.status === "idle").length} idle.`,
                ...(ownID ? [`current: ${shortID(peers, ownID)}`] : []),
              ].join("  "),
              placeholder: "Filter peers",
              options: peerOptions(peers, ownID),
              search: (query, options) => {
                // The dialog resets its size when it opens, so set it once from
                // inside the active dialog. See anomalyco/opencode#58808.
                if (!sized) {
                  sized = true
                  ctx.ui.dialog.set({ size: "xlarge", centered: true })
                }
                const needle = query.toLowerCase()
                if (needle === "") return options
                return options.filter(
                  (option) =>
                    option.title.toLowerCase().includes(needle) ||
                    (option.description ?? "").toLowerCase().includes(needle),
                )
              },
            })
            if (!selected) return
            const peer = peers.find((candidate) => candidate.id === selected)
            if (!peer) return
            const body = await ctx.ui.dialog.prompt({
              title: `Message ${peer.name ?? selected}`,
              placeholder: "Observation",
            })
            if (!body?.trim()) return
            const messageID = await queuePeerMessage(
              spool,
              peer,
              body.trim(),
              {
                id: ownID ?? `opencode-${process.pid}`,
                name: sessionID ? registry.nameFor(sessionID) ?? "opencode" : "opencode",
              },
              peer.session_id,
            )
            ctx.ui.toast.show({ title: "Peer message", message: `Queued ${messageID.slice(0, 16)} for ${selected}` })
          },
        },
      ],
    }))
  },
})
