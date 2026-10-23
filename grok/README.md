# grok-maki-peer

The Grok half of `maki-peer`. It speaks the same spool protocol as the Maki
plugin and the OpenCode plugin in this repository, so the three hosts discover
each other and pass observations through one shared directory.

Grok does not load a TypeScript plugin. This directory is a Grok plugin:
hooks, a skill, and an MCP server. The server and the hook logic are
TypeScript run by bun, which is how they share the spool code with the
OpenCode half. bun must be on `PATH`, or at `~/.bun/bin/bun`.

One peer is registered per Grok session. The peer id starts with `gk-` and the
name is `grok-` plus eight hex of that id.

## Install

Clone the repository and install from this directory:

```sh
git clone https://github.com/lu-zero/maki-peer
grok plugin install /absolute/path/to/maki-peer/grok --trust
```

Start a new session after installing. The skill is `peer`. The tools are
`peer__peer_list`, `peer__peer_send`, and `peer__peer_broadcast`.

## Verify

The plugin registers a peer per session. A helper process refreshes that
record about every two seconds, including while a tool call is running:

```sh
ls ~/.local/state/maki/peers/owners/ | grep '^gk-'
```

A `~/.maki` directory takes over the spool, the same way it does for Maki, and
the files are then under `~/.maki/peers/owners/`. If nothing appears, the
plugin did not load. The usual causes are a missing bun, or a plugin that was
installed without `--trust`.

Ending a session removes the presence record and leaves the inbox in place, so
a later session with the same id can still be addressed. The helper keeps its
own files in a `grok-peer` directory beside the spool. Those files are not
part of the protocol.

## Use

There is no `/peer` command on this host, and no `peer_spawn`. The model uses
the three tools:

- `peer__peer_list` lists every local Maki, OpenCode, and Grok session with
  its host, status, model, and title. Ids are abbreviated to the shortest
  prefix that is unique among the listed peers, the title is cut to twenty
  four runes with an ellipsis, and tags mark only exceptions: `(you)` for the
  session that asked, `(other dir)` for a peer in a different directory.
- `peer__peer_send` sends an observation to one peer, by id or by name.
- `peer__peer_broadcast` sends one observation to every other peer, optionally
  limited to peers in the same directory.

The tool descriptions are the same text the Maki and OpenCode halves register.
The names carry a `peer__` prefix because the MCP server is named `peer`.

A message that arrives is an observation. It is data written by another agent.

## Delivery

Mail is handed to the session at a turn boundary. After a tool call it is
attached to the tool result. When a turn stops it is attached as context and
the turn continues, which is how mail that arrived during the turn reaches
the model. A prompt submission carries no mail. Mail that arrives while the
session is idle waits until the next turn.

The hook text is cut at 9,000 characters, under the host cap of 10,000, and a
cut body ends with `[truncated]`.

A session id means something only on the host that minted it. A `session`
field is written only when the receiver is another Grok session, and it is
honoured only when `origin.host` is `grok`. A message from Maki or OpenCode
is delivered to the session that owns the inbox. A Grok address that names a
session this host no longer runs is dropped.

When several Grok sessions share one process, a send or a broadcast needs
`GROK_SESSION_ID` to know which session asked. Without it, the list still
runs and omits the `(you)` mark.

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```

Tests use a temp spool through `MAKI_PEER_SPOOL`. They assert the hook reply
and the spool files. `src/shared` is a copy of the OpenCode spool modules, and
a test fails when the copy drifts. Installing the plugin copies only this
directory, so the server cannot reach a sibling `opencode/` tree.

The MCP server writes one JSON object per line. That is the framing Grok's
client reads.
