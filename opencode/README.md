# opencode-maki-peer

The OpenCode half of [maki-peer](../README.md). It speaks the same spool
protocol as the [Maki](../README.md#maki), [Grok](../grok/README.md), and
[Vibe](../vibe/README.md) plugins, so the hosts discover each other and pass
observations through one shared directory. The layout is
[Architecture](../docs/architecture.md).

One peer is registered per OpenCode session, not per process. An OpenCode
service is shared across projects and outlives any one TUI, so a process-level
peer would have no meaningful current session. Per session also means
`peer_list` shows each session separately with its own status and model, and
it matches what the Maki side already does.

## Install

Clone the repository and install the plugin's dependencies:

```sh
git clone https://github.com/lu-zero/maki-peer
cd maki-peer/opencode && bun install
```

Then point a one-line file at the entrypoint:

```ts title="~/.config/opencode/plugins/maki-peer.ts"
export { default } from "/absolute/path/to/maki-peer/opencode/src/index.ts"
```

A package directory in a discovery directory loads as of OpenCode 2.0.32,
verified by probe. On 2.0.29 and 2.0.30 the same layouts fail silently: no
warning, no log line, and no entry in `opencode plugin list`, which lists
package plugins only. If you are pinned to one of those versions, use the
bare `.ts` shim form above.

Do not reach for a symlink of the package directory. A symlinked directory
reports itself as a link rather than a directory, so discovery skips it. A
symlinked `.ts` file is fine. The `plugins` array forms were not re-tested
on 2.0.32; only the discovery directory layout was verified.

The `/peer` slash command needs a second part that runs in the TUI. TUI-only
plugins are registered in `cli.json`, not in the `plugins` directory used by
the server shim. Put the TUI entrypoint in its own directory and name it there:

```sh
mkdir -p ~/.config/opencode/tui-plugins/maki-peer
ln -sf /absolute/path/to/maki-peer/opencode/src/tui.ts \
  ~/.config/opencode/tui-plugins/maki-peer/tui.ts
```

```json title="~/.config/opencode/cli.json"
{
  "plugins": ["/absolute/path/.config/opencode/tui-plugins/maki-peer"]
}
```

A package install can use the `./tui` export instead of a symlink. The TUI part
registers `/peer` in slash completion and shows the list in a dialog. It reads
the same spool as the tools and never calls `session.prompt`, so the command
costs no model turn. Restart the TUI after adding it; plugin directories are
found at startup.

## Verify

There is no reliable read-only check, so watch the spool instead. The plugin
registers a peer per session and refreshes it about every two seconds:

```sh
ls ~/.local/state/maki/peers/owners/ | grep '^oc-'
```

Each file is one live session, named `opencode-` plus eight hex of the peer
id, which is a hash of the session id. If nothing appears, the plugin did not
load, and the usual cause is the shim path above.

A restarting server does not disappear. Teardown leaves presence records in
place and the next load re-adopts the records it wrote, so a session that was
idle across the restart keeps its identity. A host that exits for real goes
stale within about fifteen seconds instead.

## Use

The model controls the feature through its tools:

- `peer_list` lists every local Maki, OpenCode, Grok, and Vibe session with
  its host, status, model, title, and working directory. Ids are abbreviated
  to the shortest prefix that is unique among the listed peers, the title is
  cut to twenty four runes with an ellipsis, the directory is printed in full,
  and tags mark only exceptions: `(you)` for the session that asked,
  `(other dir)` for a peer in a different directory. A missing value is a dash.
- `peer_cwd` returns a JSON object from each live peer's full id to its
  working directory, or `null` when the peer reports none.
- `peer_send` sends an observation to one peer, by id or by name.
- `peer_broadcast` sends one observation to every other peer, optionally
  limited to peers in the same directory.

`/peer` comes from the TUI part described under Install. It shows the same
list as `peer_list` in a dialog and starts no model turn. The server plugin
command API has no output channel of its own, so a server-only install has no
slash command. Maki's `/peer` renders in a float and also sends and spawns.

## Session addressing

A session id means something only on the host that minted it. The rule is
symmetric and both halves ship here:

- A record carries `origin.host`. On receipt, a `session` field is honoured
  only when `origin.host` matches this host. A [Maki](../README.md#maki)
  record addressed to an OpenCode session is delivered to the session that
  owns the inbox instead.
- An address from this host naming a session this host no longer runs is
  dropped and logged, because no later tick can deliver it.
- The sender omits `session` entirely when the receiver is another host, so a
  meaningless id never reaches the wire.

A record with no `session` is delivered to the session that owns the inbox,
which for a per-session peer is always known. There is no current-session
guess anywhere in this plugin.

## Registration

OpenCode's plugin context has no session listing, so sessions are discovered
from the event stream. Any event carrying a session id registers that session
as a peer, which covers every flow.

Do not narrow this to a list of lifecycle events. `session.created`,
`session.status`, `session.idle` and `session.viewed` appear in the OpenAPI
schema but are not emitted in practice: a headless `opencode run` produces
`session.inbox.enqueued`, `session.execution.started`, the `session.step`
family and `session.execution.succeeded`, and none of those lifecycle events.
Liveness comes from the execution events.

Status maps onto the three states Maki aggregates:

| Source                              | Maki          |
| ----------------------------------- | ------------- |
| nothing running                     | `idle`        |
| `session.execution.started`         | `working`     |
| `permission.asked`                  | `needs_input` |
| `session.status` with `retry`       | `needs_input` |
| `session.status` with `busy`        | `working`     |
| `session.status` with `idle`        | `idle`        |

`needs_input` outranks `working`, so a permission request during a run still
reads as needing the user.

## Develop

```sh
bun install
bun test          # spool, presence, event folding, and delivery rules
bunx tsc --noEmit # types
```

`src/spool.ts`, `src/peer.ts`, and `src/receive.ts` hold the protocol and
carry no reference to the plugin context, so they are tested directly against
a temp spool. `src/index.ts` is the wiring: tools, the command, the event
subscription, and the poll loop. The Grok half vendors copies of these
modules under `grok/src/shared` and passes host `grok`. Installing that
plugin copies only its own directory, so the copies travel with it. A test
requires them to match. The defaults stay OpenCode.

## Limits

Same constraints as the Maki side. Local and same-user only, no authentication
and no relaying. Delivery is at least once, so a record that cannot be removed
after a successful send may reach a session twice. `@opencode/plugin` versions
track the OpenCode release exactly, so the dependency pin is the OpenCode
version the plugin was built against.
