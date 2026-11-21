# A plugin cannot deliver text into an idle turn

maki-peer is an Agent Plugins 1.0 package. A Vibe session uses it to exchange
short observations with Maki, OpenCode, Grok, and Claude Code on the same
machine. Mail is claimed in `pre_agent` at a turn start or in `post_tool` after
a tool call, and appended to that context. A turn that starts while the session
is idle now sees its mail. A hook still cannot start a turn, so mail that
arrives after the session goes idle waits for the next turn and can expire
after 300 seconds.

On Vibe 3.0.4 the hook types were only `post_agent`, `pre_tool`, and
`post_tool`, so mail could only reach a turn that was already running. Vibe
3.1.1 added `pre_agent`, which this plugin now uses to claim mail at a turn
start. That closes the gap for a turn that begins after mail arrives. It does
not let a plugin start a turn in a fully idle session.

Two existing primitives would close the remaining gap.

1. Let a plugin hook supply `user_content` at `pre_agent_turn`, including one
   that starts because the session was idle. Empty stdout adds nothing.
2. Let the MCP server bound to the session call `session/turn/enqueue` for
   that session. `PLUGIN_DATA` already carries the session id.

The injected text is data from another local agent. It must not approve a
permission, change configuration, or run a slash command. ADR 0007 asks for
this kind of extension to be flagged rather than grown as a private channel.

This request is filed upstream as
[mistralai/mistral-vibe#1422](https://github.com/mistralai/mistral-vibe/issues/1422).
