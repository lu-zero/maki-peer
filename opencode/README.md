# opencode-maki-peer

The OpenCode half of `maki-peer`. It speaks the same spool protocol as the
Maki plugin in this repository, so both hosts discover each other and pass
observations through one shared directory.

One peer is registered per OpenCode session, not per process. An OpenCode
service is shared across projects and outlives any one TUI, so a process-level
peer would have no meaningful current session. Per session also means
`peer_list` shows each session separately with its own status and model, and
it matches what the Maki side already does.

## Install

From a checkout, run `bun install` in `opencode/` first so `@opencode/plugin`
resolves next to the entrypoint, then point a one-line file at it:

```ts title="~/.config/opencode/plugins/maki-peer.ts"
export { default } from "/absolute/path/to/maki-peer/opencode/src/index.ts"
```

Only a bare `.ts` or `.js` file in a discovery directory loads. A package
directory does not, whether it is named in the `plugins` array by absolute
path, by relative path, or placed inside `.opencode/plugins/`. OpenCode 2.0.29
and 2.0.30 both fail those forms silently: no warning, no log line, and no
entry in `opencode plugin list`, which lists package plugins only. A
`plugins` array entry that reads correctly can therefore leave the plugin
simply absent.

Do not reach for a symlink of the package directory. A symlinked directory
reports itself as a link rather than a directory, so discovery skips it. A
symlinked `.ts` file is fine.

## Verify

There is no reliable read-only check, so watch the spool instead. The plugin
registers a peer per session and refreshes it about every two seconds:

```sh
ls ~/.local/state/maki/peers/owners/ | grep '^oc-'
```

Each file is one live session, named `opencode:<last six of the session id>`.
If nothing appears, the plugin did not load, and the usual cause is the shim
path above.

A restarting server briefly disappears from every peer's list. Unload removes
this host's presence records, and they reappear within a couple of seconds.
A peer id is derived from the session id, so a session that comes back keeps
the same id.

## Use

There is no `/peer` command on this host. The model controls the feature
through its tools:

- `peer_list` lists every local Maki and OpenCode instance with its host,
  status, model, and title.
- `peer_send` sends an observation to one peer, by id or by name.
- `peer_broadcast` sends one observation to every other peer, optionally
  limited to peers started in the same directory.

A slash command was tried and removed. A plugin command on this host has one
output channel, `session.prompt`, which is a model turn, so a read only
listing cost a turn and read to the model as something to act on. The command
returns when upstream lets a command answer without prompting the model:
tracked in anomalyco/opencode#28292. Maki keeps its `/peer`, which renders in
a float and sends receipts as notices and therefore has no step.

## Session addressing

A session id means something only on the host that minted it. The rule is
symmetric and both halves ship here:

- A record carries `origin.host`. On receipt, a `session` field is honoured
  only when `origin.host` matches this host. A Maki record addressed to an
  OpenCode session is delivered to the session that owns the inbox instead.
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
subscription, and the poll loop.

## Limits

Same constraints as the Maki side. Local and same-user only, no authentication
and no relaying. Delivery is at least once, so a record that cannot be removed
after a successful send may reach a session twice. `@opencode/plugin` versions
track the OpenCode release exactly, so the dependency pin is the OpenCode
version the plugin was built against.
