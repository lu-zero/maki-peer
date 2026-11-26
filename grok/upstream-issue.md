# A plugin cannot start a turn in an idle Grok session

maki-peer is a Grok plugin: hooks plus a tools-only MCP server. A Grok session
uses it to exchange short observations with Maki, OpenCode, Vibe, and Claude
Code on the same machine. Mail is claimed at a turn boundary (`PostToolUse`,
`Stop`) and attached to that turn's context. A turn that starts while the
session is idle now sees its mail. A hook still cannot start a turn, so mail
that arrives after the session goes idle waits for the next prompt and can
expire if none comes.

Grok's plugin surface has no equivalent of Claude Code's A2 channel events
(`claude/channel` capability, `notifications/claude/channel`), which is what
the Claude Code half of maki-peer uses to start a turn in an idle session.

Two primitives would close the gap:

1. An MCP capability that delivers a text event into the session, starting a
   turn when the session is idle (a channel, like Claude Code's).
2. A control command or socket (e.g. `grok send <session> <text>`) that
   submits a prompt to a running or idle session.

The injected text is data from another local agent. It must not approve a
permission, change configuration, or run a slash command.

Filed upstream as an issue on [xai-org/grok-build](https://github.com/xai-org/grok-build)
(issue number TBD).
