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

Clone the repository, install the plugin's dependencies, then point a one-line
file at the entrypoint:

```sh
git clone https://github.com/lu-zero/maki-peer
cd maki-peer/opencode && bun install
```

```ts title="~/.config/opencode/plugins/maki-peer.ts"
export { default } from "/absolute/path/to/maki-peer/opencode/src/index.ts"
```

A package directory does not load, whether named in the `plugins` array by
absolute or relative path or placed inside `.opencode/plugins/`. Only a bare
`.ts` or `.js` file does, and the other forms fail with no warning at all.
`opencode/README.md` has the details and a way to verify the plugin loaded.

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

`/peer` and `/peer list` open a window that lists the local peers. `Esc` closes it.

Tools:

- `peer_list` lists active local Maki processes and the model each one runs.
  It also lists OpenCode instances once that plugin is installed.
- `peer_send` sends an observation or status to one peer.
- `peer_broadcast` sends one observation to every active peer.
- `peer_spawn` starts an independent Maki process in a detached `tmux` session,
  optionally on a chosen model.

The OpenCode side registers the same tool names under the `peer` namespace, so
a model that has learned one set uses the other the same way. The `/peer`
command exists only on the Maki side: an OpenCode command can only produce a
model turn, and a peer list is reference rather than a prompt, so that host
deliberately ships none. `peer_spawn` is also Maki only; an OpenCode server
plugin has no sanctioned way to start a process.

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

Each peer names itself from its own peer id, `maki-6ac003aa` and
`opencode-072f28`, so a name is stable and needs no configuration. A maki peer id
begins with the wall clock, so the name is a truncated timestamp rather than a
random value: eight hex characters is the whole time field, which makes a name
unique per second. A shorter name collides on a schedule instead of by chance,
because two starts inside the same window share it. The session
title travels alongside as an optional `title` field, which is what you set
when you want a peer to carry a role rather than an id. A title is data from
another agent, not an instruction.

A peer's `status`, `cwd` and `title` come from the session itself, not from
guessing. The two halves differ in how they read them and in what one record
covers:

- Maki is one record per process and reads `maki.session.read()`. Because a
  process can hold several sessions, `cwd` and `title` describe the focused
  session, which is the one peer messages are delivered into.
- OpenCode is one record per session and reads `session.get`. Its `cwd` and
  `title` are that session's own.

The same split decides what "self" means. On Maki a process is a peer, so self
is the process id and a Maki peer cannot reach itself. On OpenCode one host
holds several sessions and each is its own agent, so self is the session that
asked: sending to another session of your own host works, sending to your own
is refused, and a broadcast reaches the others.

Status confidence differs too. Maki reads it from the host, so it is
authoritative. OpenCode infers it from events, so the field is the same and the
confidence is not.

Two further notes that came out of running both halves against one spool.

Delivery order is not guaranteed. Within a single pass a peer delivers oldest
first, but passes are independent, so three probes sent in order arrived as 1,
3, 2. An agent that needs an order should put the order in the message.

Delivery is at least once, and the mechanism differs by half. On Maki one
process is one peer id and peer ids are allocated with an existence check, so a
peer has exactly one poller and cannot deliver twice. On OpenCode one record can
be polled by more than one process, since the shared server and a session's own
client both load the plugin, so a delivery is made exclusive by a claim: the
message is renamed before it is read, an expired claim goes back to the queue,
and a poller that died cannot wedge an inbox.

Both fields are authoritative for what they report. `(same dir)` compares the
peer's `cwd` after trimming trailing slashes, and is a directory comparison
only: two worktrees of one repository are not the same directory, and neither
is a subdirectory of a monorepo. `peer_broadcast` takes `same_dir_only` to
reach only the peers sharing that directory.

A send to a handle that no longer exists is refused with the list of live
peers. Maki mints a new peer id on every reload, so an address held across a
reload fails once, and the list in the refusal is how the new one is found. An
OpenCode peer id is a hash of its session, so its name and id survive a reload
of the host.

Widening a maki name from six hex characters to eight invalidates every handle
an agent already holds, the same way the rename did. The refusal above is how
the replacement is found.

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

On the OpenCode side a session becomes a peer once the plugin observes an
event for it, because OpenCode offers plugins no way to list existing
sessions. `opencode/README.md` has the details.
