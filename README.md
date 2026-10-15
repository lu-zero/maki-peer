# maki-peer

Local peer discovery and observation messaging between Maki and OpenCode.

This repository holds two plugins that share one spool protocol:

- `plugin/` is a standalone Maki plugin. It does not add a Rust API or a
  builtin namespace. It uses the same Lua APIs as other Maki packages,
  including `maki.fs`, `maki.session`, `maki.defer_fn`, and `maki.fn`.
- `opencode/` is the OpenCode plugin. See `opencode/README.md`.

Both halves write presence records and message files into the same per-user
directory, so a message from one lands in a session of the other.

## Install

### Maki

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

### OpenCode

From a checkout:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../maki-peer/opencode"]
}
```

Or pinned to a commit, with nothing to publish:

```sh
opencode plugin add 'github:lu-zero/maki-peer::path:opencode'
```

## Use

The plugin registers each Maki process in a per-user state directory and
refreshes its presence about every two seconds, plus immediately on any status
or model change. It supports local file delivery, status updates, and detached
`tmux` peers.

Commands:

```text
/peer
/peer list
/peer send <peer-id> <message>
/peer spawn [--model <provider/model-id>] [tmux] <prompt>
```

Tools:

- `peer_list` lists active local Maki processes and the model each one runs.
  It also lists OpenCode instances once that plugin is installed.
- `peer_send` sends an observation or status to one peer.
- `peer_broadcast` sends one observation to every active peer.
- `peer_spawn` starts an independent Maki process in a detached `tmux` session,
  optionally on a chosen model.

The OpenCode side registers the same tool names under the `peer` namespace and
a `/peer` command, so a model that has learned one set uses the other the same
way. `peer_spawn` exists only on the Maki side; an OpenCode server plugin has
no sanctioned way to start a process.

Example:

```text
/peer spawn tmux Investigate the failing integration test
/peer spawn --model zai/glm-5.3-flash Review the provider retry logic
/peer
/peer send <peer-id> I found a relevant edge case
```

`peer_spawn` resolves the model spec through `maki.model.info` before it
spawns, so a typo in the provider slug fails the spawn instead of dying in the
new tmux session. The spec uses the same `provider/model-id` form as the
`--model` flag. A peer reports the model it runs in its presence record, and
`peer_list` shows it next to the status. The record follows `ModelChanged`
when the peer switches model later.

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

## Delivery

A message carries the `origin` host that queued it. The `session` field names
a session on the host that minted it and means nothing anywhere else, so a
peer ignores `session` on a message whose `origin.host` is not `maki` and
routes it to the focused session instead. That rule is what lets another host
share the same spool without knowing anything about maki sessions.

A message addressed to a session that is no longer live is dropped and logged
rather than retried, because no later poll can deliver it. A message with no
address is retried, since a focused session may come back. Delivery is at
least once: if the spool file cannot be removed after a successful notify, the
message is logged and may reach the session a second time.

## Limits

This version is local-only and same-user. It does not discover peers across a
LAN, authenticate remote peers, relay messages, or create native terminal
tabs. `tmux` is the first launcher. A later transport can replace the file
spool without changing the tools or commands.

The heartbeat tracks Maki's event loop. A host blocked in a long synchronous
call stops refreshing its presence record, and peers drop it once the stale
window passes.

On the OpenCode side a session only becomes a peer once the plugin observes an
event for it, because OpenCode offers plugins no way to list existing
sessions. `opencode/README.md` has the details.
