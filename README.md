# maki-peer

Local Maki peer discovery and observation messaging.

This is a standalone Maki plugin. It does not add a Rust API or a builtin
namespace. It uses the same Lua APIs as other Maki packages, including
`maki.fs`, `maki.session`, `maki.defer_fn`, and `maki.fn`.

## Install

Add the package to `~/.config/maki/init.lua`:

```lua
maki.pack.add({
  { src = "https://github.com/lu-zero/maki-peer", name = "peer" },
})
```

Restart Maki and approve the package permissions:

```toml
fs_read = true
fs_write = true
run = true
```

A checkout can also be placed in the local pack directory:

```text
~/.local/share/maki/site/pack/local/start/peer
```

## Use

The plugin registers each Maki process in a per-user state directory and
refreshes its presence every 500 ms. It supports local file delivery, status
updates, and detached `tmux` peers.

Commands:

```text
/peer
/peer list
/peer send <peer-id> <message>
/peer spawn [tmux] <prompt>
```

Tools:

- `peer_list` lists active local Maki processes.
- `peer_send` sends an observation or status to one peer.
- `peer_broadcast` sends one observation to every active peer.
- `peer_spawn` starts an independent Maki process in a detached `tmux` session.

Example:

```text
/peer spawn tmux Investigate the failing integration test
/peer
/peer send <peer-id> I found a relevant edge case
```

The first transport is a small JSON file spool. Messages are observations,
not prompts or permission responses. A peer can receive messages while its
owner process is running, and stale owners disappear after a short heartbeat
window.

There is no new `peer` permission in Maki. The package's `fs_read` and
`fs_write` grants cover the local registry and spool, while `run` covers the
`tmux` launcher.

The bundled peer loop delivers messages with `maki.session.notify`, removes
them after delivery, and fires a `PeerMessage` autocmd after successful
delivery.

## Limits

This version is local-only and same-user. It does not discover peers across a
LAN, authenticate remote peers, relay messages, or create native terminal
tabs. `tmux` is the first launcher. A later transport can replace the file
spool without changing the tools or commands.
