# maki-peer

Local peer discovery and observation messaging between Maki, OpenCode, Grok,
and Vibe.

Four plugins share one spool. A message from one lands in a session of
another. The tool descriptions match, so a model that has learned one set
uses the others the same way. A test fails the build when one description
drifts.

## Demo

[![asciicast](https://asciinema.org/a/7uIuWwyTtwsFVhDp.svg)](https://asciinema.org/a/7uIuWwyTtwsFVhDp)

Watch [four hosts, one directory](https://asciinema.org/a/7uIuWwyTtwsFVhDp).
Maki, Vibe, OpenCode, and Grok exchange notes in `~/Sources/maki-peer`. The
broadcast is `same_dir_only`. A peer outside that directory is listed as
`(other dir)` and receives nothing.

## Harnesses

- [Maki](#maki), the Lua plugin in `plugin/`.
- [OpenCode](opencode/README.md)
- [Grok](grok/README.md)
- [Vibe](vibe/README.md)
- [Architecture](docs/architecture.md), the spool and delivery.

The spool is `~/.maki/peers` when `~/.maki` is a directory, otherwise
`$XDG_STATE_HOME/maki/peers` or `~/.local/state/maki/peers`. A live session
is `owners/<peer-id>.json`. Mail is `inboxes/<peer-id>/<message-id>.json`.
The prefixes are `peer-`, `oc-`, `gk-`, and `vb-`.

bun must be on `PATH`, or at `~/.bun/bin/bun`, for OpenCode, Grok, and Vibe.

### Maki

```lua
maki.pack.add({
  { src = "https://github.com/lu-zero/maki-peer", name = "peer" },
})
```

A symlink of this repository works in the local pack directory:

```sh
mkdir -p ~/.local/share/maki/site/pack/local/start
ln -s /absolute/path/to/maki-peer ~/.local/share/maki/site/pack/local/start/maki-peer
```

Approve `fs_read`, `fs_write`, `run`, and `session_write`. A checkout you
placed there is granted what `plugin.toml` asks for. There is no separate
`peer` permission. `session_write` covers `maki.session.notify`.

Tools: `peer_list`, `peer_send`, `peer_broadcast`, `peer_spawn`. `/peer`
lists peers, and it can send or spawn.

### OpenCode

Point `~/.config/opencode/plugins/maki-peer.ts` at the entrypoint:

```ts
export { default } from "/absolute/path/to/maki-peer/opencode/src/index.ts"
```

Tools: `peer_list`, `peer_send`, `peer_broadcast`. Install, the shim, and
delivery are in the [OpenCode](opencode/README.md) page.

### Grok

```sh
grok plugin install /absolute/path/to/maki-peer/grok --trust
```

Tools: `peer__peer_list`, `peer__peer_send`, `peer__peer_broadcast`. Install
and delivery are in the [Grok](grok/README.md) page.

### Vibe

Copy or symlink `vibe/` to `~/.vibe/plugins/maki-peer`, then start a session
or run `/reload`.

Tools: `mcp_peer.peer_list`, `mcp_peer.peer_send`, `mcp_peer.peer_broadcast`.
Install and delivery are in the [Vibe](vibe/README.md) page.

## Use

A message is an observation or a status. It is data from another agent. It
is not a prompt. Each host prints `[peer name id] topic: body`, and omits
the topic when there is none.

`peer_send` reaches one peer. `peer_broadcast` reaches every other live
peer. `same_dir_only` limits a broadcast to one directory, compared after
trailing slashes are removed. A peer with no directory never matches. There
is no undo. Sending to your own session is refused. `wake: true` asks the
receiving host to start a turn when its session is idle; without it the
message waits for the session's next turn.

| Host                           | List                 | Send                 | Broadcast                  |
| ------------------------------ | -------------------- | -------------------- | -------------------------- |
| [Maki](#maki)                  | `peer_list`          | `peer_send`          | `peer_broadcast`           |
| [OpenCode](opencode/README.md) | `peer_list`          | `peer_send`          | `peer_broadcast`           |
| [Grok](grok/README.md)         | `peer__peer_list`    | `peer__peer_send`    | `peer__peer_broadcast`     |
| [Vibe](vibe/README.md)         | `mcp_peer.peer_list` | `mcp_peer.peer_send` | `mcp_peer.peer_broadcast`  |

`/peer` and `peer_spawn` exist only on Maki. `peer_spawn` starts a detached
`tmux` session. The model spec is `provider/model-id`.

```text
/peer
/peer send <peer-id> I found a relevant edge case
/peer spawn tmux Investigate the failing integration test
```

Ids, the `session` field, delivery, and the local-only limits are in
[Architecture](docs/architecture.md).
