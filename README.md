# maki-peer

Local peer discovery and observation messaging between Maki, OpenCode, Grok,
Vibe, and Claude Code.

Five plugins share one spool. A message from one lands in a session of
another. The tool descriptions match, so a model that has learned one set
uses the others the same way. A test fails the build when one description
drifts.

## Demo

[![asciicast](https://github.com/user-attachments/assets/4ebb42a3-81b7-4175-a0ba-8ac948f2d10c)](https://asciinema.org/a/1270698)

Watch [four hosts, one directory](https://asciinema.org/a/1270698). The preview
is a GitHub user attachment because the image proxy cannot fetch asciinema.org
right now.
Maki, Vibe, OpenCode, and Grok exchange notes in `~/Sources/maki-peer`. The
broadcast is `same_dir_only`. A peer outside that directory is listed as
`(other dir)` and receives nothing.

## Harnesses

- [Maki](#maki), the Lua plugin in `plugin/`.
- [OpenCode](opencode/README.md)
- [Grok](grok/README.md)
- [Vibe](vibe/README.md)
- [Claude Code](claude/README.md)
- [Architecture](docs/architecture.md), the spool and delivery.
- [Claude Code compatibility](docs/claude-compat.md), design notes.

The spool is `~/.maki/peers` when `~/.maki` is a directory, otherwise
`$XDG_STATE_HOME/maki/peers` or `~/.local/state/maki/peers`. A live session
is `owners/<peer-id>.json`. Mail is `inboxes/<peer-id>/<message-id>.json`.
The prefixes are `mk-`, `oc-`, `gk-`, `vb-`, and `cc-`.

bun must be on `PATH`, or at `~/.bun/bin/bun`, for OpenCode, Grok, Vibe, and
Claude Code.

Upgrading from a build that used `peer-` ids: Maki now uses `mk-`. Old
`owners/peer-*.json` records age out on their own. Mail already queued in
`inboxes/peer-*` is not moved, so let running sessions drain it before you
upgrade, or clear those directories by hand.

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

Tools: `peer_list`, `peer_cwd`, `peer_send`, `peer_broadcast`, `peer_spawn`. `/peer`
lists peers, and it can send or spawn. `/peer wake <count>` makes this host wake a
session once more than <count> peer messages sit unread in it (`/peer wake off`
restores waking only on messages that set `wake`); `/peer wake` shows the current
threshold.

### OpenCode

From a checkout, run `bun opencode/install.ts`. It writes the server shim and
registers the TUI half that provides `/peer`. Restart the TUI after installing.

Tools: `peer_list`, `peer_cwd`, `peer_send`, `peer_broadcast`. The shim, the
TUI part, and delivery are in the [OpenCode](opencode/README.md) page.

### Grok

```sh
grok plugin install /absolute/path/to/maki-peer/grok --trust
```

Tools: `peer__peer_list`, `peer__peer_cwd`, `peer__peer_send`,
`peer__peer_broadcast`. Install and delivery are in the
[Grok](grok/README.md) page.

### Vibe

Copy or symlink `vibe/` to `~/.vibe/plugins/maki-peer`, then start a session
or run `/reload`.

Tools: `mcp_peer.peer_list`, `mcp_peer.peer_cwd`, `mcp_peer.peer_send`,
`mcp_peer.peer_broadcast`. Install and delivery are in the
[Vibe](vibe/README.md) page.

### Claude Code

```sh
claude --plugin-dir /absolute/path/to/maki-peer/claude
```

The tools use Claude's scoped MCP names, such as
`mcp__plugin_maki-peer_peer__peer_list`. Install, optional channel delivery,
and the limits are in the [Claude Code](claude/README.md) page.

## Use

A message is an observation or a status. It is data from another agent. It
is not a prompt. Each host prints `[peer name id] topic: body`, and omits
the topic when there is none.

`peer_send` reaches one peer. `peer_broadcast` reaches every other live
peer. `same_dir_only` limits a broadcast to one directory, compared after
trailing slashes are removed. A peer with no directory never matches. There
is no undo. Sending to your own session is refused. `wake: true` asks the
receiving host to start a turn for the note when its session is idle. Maki
and Claude Code do that. OpenCode resumes on every delivery, and Grok and Vibe
attach the note to the next turn without starting one.

`peer_list` shows the live peers with their id, status, model, title, working
directory, and host. A peer with no model, title, or directory shows a dash.
Lists with more than four peers start with a count, put working and waiting
peers first, and group idle peers by directory with the full path in the
heading. `peer_cwd` returns the same directories as a JSON object keyed by the
full peer id, with `null` for a peer that reports none.

| Host                            | List        | Directories  | Send         | Broadcast         |
| ------------------------------- | ----------- | ------------ | ------------ | ----------------- |
| [Maki](#maki)                   | `peer_list` | `peer_cwd`   | `peer_send`  | `peer_broadcast`  |
| [OpenCode](opencode/README.md)  | `peer_list` | `peer_cwd`   | `peer_send`  | `peer_broadcast`  |
| [Grok](grok/README.md)          | `peer_list` | `peer_cwd`   | `peer_send`  | `peer_broadcast`  |
| [Vibe](vibe/README.md)          | `peer_list` | `peer_cwd`   | `peer_send`  | `peer_broadcast`  |
| [Claude Code](claude/README.md) | `peer_list` | `peer_cwd`   | `peer_send`  | `peer_broadcast`  |

The short names in the table are the tool names. Grok prefixes them with
`peer__`, Vibe with `mcp_peer.`, and Claude Code with
`mcp__plugin_maki-peer_peer__`.

`/peer` lists peers on Maki and on OpenCode, where the installer registers the
TUI half. On Maki it also sends and spawns. `peer_spawn` exists only on Maki
and starts a detached `tmux` session. The model spec is `provider/model-id`.

```text
/peer
/peer send <peer-id> I found a relevant edge case
/peer spawn tmux Investigate the failing integration test
```

The use cases, including waking a team in one run, are in
[Use cases](docs/use-cases.md). Ids, the `session` field, delivery, and the
local-only limits are in [Architecture](docs/architecture.md).

## Skills

Each host ships a `peer` skill for finding peers and sending notes. The
`peer-lane-coordination` skill covers the other direction: it tells a
coordinator how to run several peers as lanes, from roll call and dispatch to
answering reports and retiring worktrees.

`skills/peer-lane-coordination/common.md` is the workflow. Each harness has a
short note in `skills/peer-lane-coordination/harnesses/` for its tool names and
delivery rules. `just skills` assembles them into `grok/skills`, `vibe/skills`
and `claude/skills`, which ship with those plugins. Maki and OpenCode have no
package-provided skill discovery, so their copies go to `skills/install/`.
`just install-skills` puts those in `~/.config/maki/skills` and
`~/.config/opencode/skills` (`$XDG_CONFIG_HOME` wins), and refreshes the
personal `~/.claude/skills` copy. `just skills-check` fails when a checked-in
copy is stale.

## Develop

`just setup` installs the Rust and host dependencies at the pinned versions.
`just all` runs every check in CI order. A single host can be checked with
`just opencode`, `just grok`, `just vibe`, or `just claude`.
`just install-opencode` points this checkout at the local OpenCode install,
including the TUI half and `/peer`. `just skills` regenerates the skills from
their common source and harness notes.

CI pins bun 1.4.2. The four host packages pin TypeScript 7.0.2 and
`@types/bun` 1.4.5, and each lockfile is committed. Dependabot proposes weekly
updates; the maki host pin has to move before the `monty` crates can follow.
