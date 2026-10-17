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

The discovery-directory layout changed across OpenCode versions. On 2.0.29 and
2.0.30 a package directory failed silently in every form, and only a bare
`.ts` or `.js` file loaded. As of 2.0.32 a package directory placed in the
discovery directory loads, verified by probe; the `plugins` array forms were
not re-tested on that release.
`opencode/README.md` has the details and a way to verify the plugin loaded.

## Use

The plugin registers each live Maki session in a per-user state directory and
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

- `peer_list` lists every live local session, with its model, status, and abbreviated id.
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
delivers it into the session the record belongs to. That rule is what lets
another host share the same spool without knowing anything about maki
sessions.

Each peer names itself from its own peer id, `maki-Cg68nHqT` and
`opencode-072f2841`, so a name is stable and needs no configuration. A maki peer
id is the session's storage id, so the name is the first eight characters of
that id: stable across reloads, like the OpenCode name. The session
title travels alongside as an optional `title` field, which is what you set
when you want a peer to carry a role rather than an id. A title is data from
another agent, not an instruction.

`peer_list` abbreviates ids the way git abbreviates hashes: the shortest
prefix that is unique among the live peers, never shorter than four
characters. A shortened form is a working handle, since resolution accepts
any unambiguous prefix, and an ambiguous one is refused with the candidates
that share it. The list omits the name, which is only the label plus the id
prefix the line already carries. A title keeps up to sixty four runes in the
record and is cut to twenty four with an ellipsis on the list line, which is
one line per peer and has a widest entry to protect.

A peer's `status`, `cwd` and `title` come from the session itself, not from
guessing, and both halves work the same way: one record per session, each
reading its own host. Maki reads `maki.session.read()` for the session its
record names, OpenCode reads `session.get`. A peer is a session, on either
host.

That makes "self" the same rule everywhere. Self is the session that asked:
sending to your own session is refused, sending to another session of your own
host works, and a broadcast reaches the others.

Status confidence differs. Maki reads it from the host, so it is
authoritative. OpenCode infers it from events, so the field is the same and the
confidence is not.

Two further notes that came out of running both halves against one spool.

Delivery order is not guaranteed. Within a single pass a peer delivers oldest
first, but passes are independent, so three probes sent in order arrived as 1,
3, 2. An agent that needs an order should put the order in the message.

Delivery is at least once, and the mechanism differs by half. On Maki the peer
id is the session's storage id, and storage locks a live session to the one
process holding it, so a record has exactly one poller and cannot deliver
twice. On OpenCode one record can be polled by more than one process, since
the shared server and a session's own client both load the plugin, so a
delivery is made exclusive by a claim: the message is renamed before it is
read, an expired claim goes back to the queue, and a poller that died cannot
wedge an inbox.

Both fields are authoritative for what they report. The list tags only the
exceptions: `(you)` marks the session that asked, and `(other dir)` marks a
peer whose `cwd` differs from it, compared after trimming trailing slashes.
Two worktrees of one repository are not the same directory, and neither is a
subdirectory of a monorepo. `peer_broadcast` takes `same_dir_only` to reach
only the peers sharing that directory.

A send to a handle that no longer exists is refused with the list of live
peers. A Maki peer id is the session's storage id, so it survives a reload: the
next process resumes the session under the same id and the address keeps
working, and so do the record and any queued mail, which the next process takes
over instead of rebuilding. An OpenCode peer id is a hash of its session and behaves the same
way. A handle goes stale only when the session itself is gone, and the list in
the refusal is how a replacement is found.

A message addressed to a session that is no longer live is dropped and logged
rather than retried, because no later poll can deliver it. A message with no
session of its own is retried, since a session may resume under the same id.
Delivery is at least once: if the spool file cannot be removed after a
successful notify, the message is logged and may reach the session a second
time.

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
