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

From a checkout of this repository:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../maki-peer/opencode"]
}
```

Or install it pinned to a commit, with no publish step:

```sh
opencode plugin add 'github:lu-zero/maki-peer::path:opencode'
```

`opencode plugin check` and `opencode plugin update` manage the installed
version. An entry pinned to a full commit hash stays put; an unpinned one is
checked for updates in the background.

## Use

Commands:

```text
/peer
/peer send <peer-id> <message>
```

Tools:

- `peer_list` lists every local Maki and OpenCode instance with its host,
  status, and model.
- `peer_send` sends one observation to one peer.
- `peer_broadcast` sends one observation to every other peer.

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

OpenCode's plugin context has no session listing, so a session becomes a peer
the first time this plugin sees an event for it: `session.created`,
`session.status`, `session.idle`, `session.viewed`, `session.model.selected`,
or a permission request. A session that already existed and has not moved
since the plugin loaded will not appear until one of those happens.

Status maps from OpenCode's `SessionStatus` onto the three states Maki
aggregates:

| OpenCode              | Maki          |
| --------------------- | ------------- |
| `idle`                | `idle`        |
| `busy`                | `working`     |
| `retry`               | `needs_input` |
| permission requested  | `needs_input` |

## Develop

```sh
bun install
bun test          # spool, presence, and delivery rules
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
