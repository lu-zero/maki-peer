# Claude Code compatibility notes

Status: the fifth host is implemented in [`claude/`](../claude/README.md).
Channel delivery is the optional A2 bridge. This page keeps the reasoning and
the alternatives.

There were no notes on this subject in the repository. This page records the
choices that led to the fifth host and the ones still open.

## What maki-peer has today

Five hosts share one local spool. A presence record is
`owners/<peer-id>.json` and a message is `inboxes/<peer-id>/<message-id>.json`.
Records carry `origin.host` and an optional `cwd`. A `session` field is honoured
only when it names the reading host's own id format. Delivery is at least once
and a file is claimed by rename before it is read. See
[Architecture](architecture.md).

Each host also exposes the same three tools plus a directory tool. Tool
descriptions are byte identical and a test fails when they drift.

## What "the Claude Code protocol" can mean

Four different interfaces are called the Claude Code protocol. They solve
different problems.

1. **Cross-session messaging.** Since v2.1.224 Claude Code lists local sessions
   with `ListAgents` and sends text with `SendMessage`. On this machine the
   message travels over a per-session Unix socket, or a named pipe on Windows,
   and never reaches Anthropic servers. Each session exports
   `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and
   Bash commands. Messages are plain text only. Inbound mail can be accepted,
   held, or refused, and a delivered message starts a turn in an idle session.
   Bursts and long exchanges are throttled and the serialized message has a cap.

   The docs describe how to find the socket and how to open a connection with
   the auth line `{"type":"auth","token":"<token>"}`. They do not describe the
   payload that follows it. A script that posts to the socket has a documented
   handshake but an undocumented message format.

2. **Agent teams.** An experimental feature, off unless
   `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set. A team lives in
   `~/.claude/teams/session-<eight chars>/config.json`, with one mailbox per
   agent at `inboxes/<agent-name>.json`. Tasks live under
   `~/.claude/tasks/<team>/`. Claude validates every mailbox entry when it
   reads the file and removes entries that do not match the message format. The
   team config is removed when the session ends, while the task directory
   stays. Structured protocol messages stay inside a team; cross-session mail
   is plain text.

3. **Plugin packaging and hooks.** A plugin has `.claude-plugin/plugin.json`,
   `hooks/hooks.json`, and may bundle an MCP server through `.mcp.json`. Paths
   use `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`. A command hook reads
   event JSON on stdin and may answer on stdout with `hookSpecificOutput`. The
   Grok half already uses this layout, and its `canonicalEvent()` accepts both
   Claude's PascalCase names and Grok's snake_case names.

4. **Channels.** An MCP server declares the `claude/channel` capability and
   emits `notifications/claude/channel` with a text `content` and optional
   `meta` keys. Claude receives each event as a `<channel source="...">` tag.
   Events queue and reach Claude on its next turn. This is a documented push
   path, but it is research preview. Custom channels need
   `--dangerously-load-development-channels` and are not on the default
   allowlist. Organization policy can disable channels entirely.

## Options

### A1. Bridge into the cross-session socket

A small helper reads maki mail and posts it into a Claude session's socket. It
would start from a hook so it inherits the socket path and token.

Good: Claude handles idle wake, inbound controls, and throttling. No plugin
code is needed inside Claude Code.

Bad: the socket belongs to one live session and disappears with it. A helper
that outlives the hook may lose own-child verification on macOS and have its
mail held for approval. Plain text drops `topic`, `kind`, and `origin.host`.
`ListAgents` cannot see maki peers, so discovery stays one way. The message
size cap is far above our own caps but is still a limit we do not control. The
message payload is not documented, so each Claude release could break it.

### A2. Bridge through a channel MCP server

A channel server started by Claude reads a maki inbox and emits a channel
notification for each message. One server per Claude session gives it a stable
place to poll while the session lives.

Good: the notification contract is documented and is ordinary MCP over stdio,
which the existing MCP code already knows. There is no token to inherit and no
own-child check to lose. Claude queues the events and delivers them on the next
turn. A reply tool could carry observations back into the spool.

Bad: channels are research preview and need a development flag until allowlisted.
The session, not the bridge, starts the server, so the bridge cannot outlive it.
The event is plain text in a `<channel>` tag, so `origin.host`, `topic`, and
`kind` must be folded into `meta` or the text. `meta` keys must be identifiers;
a hyphen is silently dropped. Sender gating is the bridge's job. Permission
relay must stay off, since mail must never approve a tool call.

### B. Translate into agent team mailboxes

Write maki messages into `inboxes/<agent>.json` and read Claude messages back
into the spool.

Good: both sides are files, which suits the spool and is easy to test.

Bad: teams are experimental and off by default. A session needs a team and a
lead before it has a mailbox, so a lone Claude session cannot join. The team
name comes from the session id and its config is deleted at session end, so it
offers no stable address for a maki peer. The entry schema is not published as
a contract and malformed entries are dropped. One team per session and no
nested teams leave no place for other hosts.

### C. A Claude Code host plugin on the maki spool

Add a fifth host directory with hooks and an MCP server, reusing the shared
spool modules the way Grok and Vibe do. Its id prefix would be `cc-`.

Good: the spool keeps its full record shape, including `origin.host`, `cwd`,
`topic`, and `kind`. The existing test harness and the byte identical shared
copies cover most of the code. No experimental Claude feature is needed.

Bad: hooks are event driven, so presence needs a helper process like the Grok
daemon. A hook can attach text to a turn but cannot start one, so `wake` has the
same limit as Vibe. Claude's plugin permission grants differ from maki's
`plugin.toml`, so the two manifests need separate review.

### D. MCP tool shim only

Expose `peer_list`, `peer_cwd`, `peer_send`, and `peer_broadcast` as MCP tools
and stop there.

Good: smallest possible step, and the MCP server from option C is needed
anyway.

Bad: there is no push delivery. Idle sessions never see mail unless the model
calls a tool. Tool names must avoid the built in `SendMessage`, so use the
scoped MCP names Claude gives them.

## Recommendation

Option C was taken, with option D as its first increment. It preserves the
protocol invariants that the other hosts already agree on and it can be tested
without a Claude process. The optional channel bridge is A2, not A1: the
channel contract is documented while the socket payload is not. Option B is
only useful for a user who already runs teams and wants maki peers inside them.

## Vibe support check

Checked against Vibe 3.1.4, the current release, and its installed package.
Issue #1422 is still open, with no assignee and no pull request. The plugin
hook types are `post_agent`, `pre_tool`, `post_tool`, `pre_agent`,
`notification`, `session_start`, `session_end`, `pre_llm`, and `post_llm`.
There is still no `pre_agent_turn`, and `session/turn/enqueue` is still only
available to app server clients. Nothing in 3.1.4 closes the idle delivery gap.

Vibe 3.1.3 added `pre_llm` and `post_llm`, and lets `post_agent` and `post_llm`
ask the model to try again within a budget of three retries per turn. That is
an improvement for delivery during an active turn, which the Vibe half already
covers with `pre_agent` and `post_tool`. It does not start a turn in an idle
session, so the limit documented in [Vibe](../vibe/README.md) still holds.

## Decisions

- `PostToolUse` and `Stop` are the two events where the hook attaches
  `additionalContext`. Idle mail is the plugin monitor's job.
- The session id comes from the hook's `session_id`. A hash of it gives `cc-`
  ids the same way OpenCode and Vibe build theirs.
- Presence is kept fresh by a hook started daemon. It keeps its lock, heartbeat
  and session files in `claude-peer` beside the spool, never in the spool.
- `wake` starts a Claude turn through a plugin monitor, whose output line wakes
  an idle session. It needs no startup flag, unlike a channel, and has no
  timeout to re-arm, unlike an `asyncRewake` hook. The docs do not promise the
  wake, so it was checked live on Claude Code 2.1.330.
- Tools use Claude's scoped MCP names so the built in `SendMessage` and
  `ListAgents` are untouched.
- Description parity is checked in `tests/plugin.rs` across all five hosts.
- Tests are headless: shared modules, hook stdout, tool results, and channel
  events. A live Claude session is not needed.
- Peer text is data from another session and never user consent. That matches
  maki's rule that an observation is data, not a prompt.

## Sources

- [Agent teams](https://code.claude.com/docs/en/agent-teams.md)
- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md)
- [Channels reference](https://code.claude.com/docs/en/channels-reference.md)
- [Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Tools reference](https://code.claude.com/docs/en/tools-reference.md)
- [Vibe issue #1422](https://github.com/mistralai/mistral-vibe/issues/1422)
