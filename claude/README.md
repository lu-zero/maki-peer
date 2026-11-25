# claude-maki-peer

The Claude Code half of [maki-peer](../README.md). It speaks the same spool
protocol as the [Maki](../README.md#maki), [OpenCode](../opencode/README.md),
[Grok](../grok/README.md), and [Vibe](../vibe/README.md) plugins, so the hosts
discover each other and pass observations through one shared directory. The
layout is [Architecture](../docs/architecture.md).

The plugin is a `.claude-plugin` package with hooks, skills, and an MCP server.
The server and hook logic are TypeScript run by bun, which is how they share the
spool code with the OpenCode half. bun must be on `PATH`, or at
`~/.bun/bin/bun`.

One peer is registered per Claude Code session. The peer id starts with `cc-`
and the name is `claude-` plus eight hex of that id.

## Install

For a local checkout, load the directory for one session:

```sh
claude --plugin-dir /absolute/path/to/maki-peer/claude
```

For a lasting install, add the repository as a marketplace and install the
plugin from it inside Claude Code. The marketplace manifest is at the repository
root and points at `claude/`:

```text
/plugin marketplace add /absolute/path/to/maki-peer
/plugin install maki-peer@maki-peer
```

With a published marketplace, the single line is
`/plugin install maki-peer --marketplace <owner>/<repo>`.

Start a new session after installing. The skills are `peer` and
`peer-lane-coordination`. The MCP tools use
Claude's scoped names, for example `mcp__plugin_maki-peer_peer__peer_list`.

## Verify

The plugin registers a peer per session and a helper refreshes it about every
two seconds:

```sh
ls ~/.local/state/maki/peers/owners/ | grep '^cc-'
```

A `~/.maki` directory takes over the spool the same way it does for Maki. If
nothing appears, check that bun is installed and that the plugin loaded.

## Use

- `peer_list` lists every local peer with its host, status, model, title, and
  working directory. Ids are abbreviated to the shortest unique prefix, the
  title is cut for width, and the directory is printed in full. Tags mark
  `(you)` and `(other dir)`.
- `peer_cwd` returns a JSON object from each live peer's full id to its
  working directory, or `null` when the peer reports none.
- `peer_send` sends an observation to one peer.
- `peer_broadcast` sends one observation to every other peer, optionally
  limited to the same directory.

A note that arrives is printed as `[peer name id] topic: body`, attached to a
tool result or the end of a turn. Claude hooks do not report a model or a
session title, so those two columns read as a dash for a Claude peer in
`peer_list`.

## Idle wake

The plugin's `peer-wake` monitor polls the session's inbox once a second. When
a note has `wake: true`, the monitor prints the inbox. An idle session starts a
turn, and a running turn gets the note as it goes. Notes without `wake` wait
for the next turn. A note that lands during a permission prompt waits until
the prompt closes and cannot answer it.

Each note is one JSON encoded line, so a body cannot forge a second event. A
sender can start six turns a minute; a wake over that limit waits in the inbox.
Plugin monitors do not run under `claude -p`.

## Optional channel delivery

Claude Code [channels](https://code.claude.com/docs/en/channels.md) can push
events into a running session. Channels are research preview, need an explicit
session flag, and require claude.ai or Console authentication. The default
remains hook delivery and needs no channel setup.

To use a channel instead:

1. Set `MAKI_PEER_CHANNELS=1` in the environment that starts Claude Code. This
   makes the MCP server declare the `claude/channel` capability and poll its
   session inbox. Hooks stay active as a fallback. A message is claimed by a
   file rename before delivery, so the hook and the channel cannot both deliver
   the same note.
2. Start Claude with the channel enabled. For a local `--plugin-dir` install:

   ```sh
   MAKI_PEER_CHANNELS=1 claude \
     --plugin-dir /absolute/path/to/maki-peer/claude \
     --dangerously-load-development-channels server:peer
   ```

   Accept the local development warning. For an installed plugin the entry is
   `plugin:maki-peer@maki-peer`, passed to `--channels` once the plugin is
   allowlisted.

The server then polls its own session inbox and emits
`notifications/claude/channel` with the note as content and `peer_id` and
`origin_host` as meta. Events queue and reach Claude on its next turn. Only
records from known local hosts are emitted. Permission relay is not declared,
so a note can never approve a tool call.

Channel mode does not read `wake`; the monitor handles it.

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```

Tests use a temporary spool through `MAKI_PEER_SPOOL`. They assert the hook
output, the spool files, the tool results, and the channel notification. The
`src/shared` copies are checked against the OpenCode sources byte for byte.
