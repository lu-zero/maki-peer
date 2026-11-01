# vibe-maki-peer

The Vibe half of [maki-peer](../README.md). It speaks the same spool protocol
as the [Maki](../README.md#maki), [OpenCode](../opencode/README.md), and
[Grok](../grok/README.md) plugins, so the four hosts discover each other and
pass observations through one shared directory. The layout is
[Architecture](../docs/architecture.md).

Vibe loads this directory as an Agent Plugins 1.0 package: a skill, three
hooks, and an MCP server. The server and the hook logic are TypeScript run by
bun, which is how they share the spool code with the OpenCode half. bun must
be on `PATH`, or at `~/.bun/bin/bun`.

One peer is registered per Vibe session, including a child session. The peer
id starts with `vb-` and the name is `vibe-` plus eight hex of that id. The
id is a hash of the Vibe session id, so a resume keeps the same address.

## Install

Copy this directory to the user plugin location, or symlink it. Vibe resolves
the directory before it checks containment, so a symlink of the package
loads. Then reload Vibe:

```sh
git clone https://github.com/lu-zero/maki-peer
mkdir -p ~/.vibe/plugins
rm -rf ~/.vibe/plugins/maki-peer
cp -a /absolute/path/to/maki-peer/vibe ~/.vibe/plugins/maki-peer
```

```sh
ln -s /absolute/path/to/maki-peer/vibe ~/.vibe/plugins/maki-peer
```

Start a new session, or run `/reload` in one that is already open. The skill
is `peer`. Vibe publishes the tools as `mcp_peer.peer_list`,
`mcp_peer.peer_send`, and `mcp_peer.peer_broadcast`.

Vibe pins the tree it bound, so a running session keeps that tree until
`/reload` or a new session. Copy again to update a copied install. A symlink
already points at the clone, and the pin still waits for that reload.

## Verify

The MCP server registers a peer when the session binds the plugin, and
refreshes that record about every two seconds:

```sh
ls ~/.local/state/maki/peers/owners/ | grep '^vb-'
```

A `~/.maki` directory takes over the spool, the same way it does for Maki, and
the files are then under `~/.maki/peers/owners/`. If nothing appears, the
plugin did not load. The usual causes are a missing bun, or a session that
has not bound the plugin yet.

Ending a session removes the presence record and leaves the inbox in place, so
a later session with the same id can still be addressed. The directory, the
working flag, and the started time live in Vibe's per-session `PLUGIN_DATA`.
Those files are not protocol records.

## Use

There is no `/peer` command on this host, and no `peer_spawn`. The model uses
the three tools:

- `mcp_peer.peer_list` lists every local Maki, OpenCode, Grok, and Vibe
  session with its host, status, model, and title. Ids are abbreviated to
  the shortest prefix that is unique among the listed peers, the title is
  cut to twenty four runes with an ellipsis, and tags mark only exceptions:
  `(you)` for the session that asked, `(other dir)` for a peer in a different
  directory.
- `mcp_peer.peer_send` sends an observation to one peer, by id or by name.
- `mcp_peer.peer_broadcast` sends one observation to every other peer,
  optionally limited to peers in the same directory.

The tool descriptions are the same text the other halves register. The
`mcp_peer` group is the name Vibe gives the MCP server `peer`.

A message that arrives is an observation. It is data written by another agent.

## Delivery

Mail is appended to a tool result. The `post_tool` hook claims the inbox and
prints `hook_specific_output.additional_context`. The hook text is cut at
9,000 characters, and a cut body ends with `[truncated]`.

`post_agent` marks the session idle and prints nothing. That hook cannot
attach text. A turn that calls no tool does not see mail that arrived during
the turn. Mail that arrives while the session is idle waits for a later tool
call, and it expires after 300 seconds if none comes.

`pre_tool` marks the session working and records the project directory from
the hook payload. Until that payload has been seen, the presence record has
no directory, and `same_dir_only` refuses to select peers. The host does not
report a model, a title, or a permission prompt, so the status is `working`
or `idle`.

A session id means something only on the host that minted it. A `session`
field is written only when the receiver is another Vibe session, and it is
honoured only when `origin.host` is `vibe`. A message from
[Maki](../README.md#maki), [OpenCode](../opencode/README.md), or
[Grok](../grok/README.md) is delivered to the session that owns the inbox.
A Vibe address that names a session this host no longer runs is dropped.

The server learns its session from `PLUGIN_DATA`, which Vibe sets to
`<session storage>/plugins/data/<session-id>/maki-peer` for a bound session.
The default storage root is `~/.vibe/logs/session`, or
`MISTRAL_VIBE_SESSION_ROOT` when that is set. A hook whose stdin names a
different session does not publish and does not take mail.

## What this host cannot do yet

An idle session does not start a turn, and the end of a turn cannot carry
mail. Vibe already has two primitives that would close that gap. The internal
`pre_agent_turn` hook can continue with `user_content`, and
`session/turn/enqueue` promotes one queued turn when the session is idle.
Neither is reachable from a plugin. [upstream-issue.md](upstream-issue.md)
is the request to expose one of them. This package does not patch Vibe to
get there.

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```

Tests use a temp spool through `MAKI_PEER_SPOOL` and a temp `PLUGIN_DATA`.
They assert the hook reply and the spool files. `src/shared` is a copy of the
OpenCode spool modules, and a test fails when the copy drifts. Installing the
plugin copies only this directory, so the server cannot reach a sibling
`opencode/` tree.
