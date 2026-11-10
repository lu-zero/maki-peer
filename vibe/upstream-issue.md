# A plugin cannot deliver text into an idle turn

maki-peer is an Agent Plugins 1.0 package. A Vibe session uses it to exchange
short observations with Maki, OpenCode, and Grok on the same machine. Mail is
claimed in `post_tool` and appended to the tool result. A session that calls
no tool, or that is idle, never sees it. Observations expire after 300
seconds.

On Vibe 3.0.4 a headless session called `mcp_peer.peer_list` and
`mcp_peer.peer_send`. `pre_tool` recorded the working directory, and
`post_tool` appended an observation to the tool result. `HookType` is still
only `post_agent`, `pre_tool`, and `post_tool`. `post_agent` cannot append
text.

Two existing primitives would close it.

1. Let a plugin hook supply `user_content` at `pre_agent_turn`, including a
   turn that starts because the session was idle. Empty stdout adds nothing.
2. Let the MCP server bound to the session call `session/turn/enqueue` for
   that session. `PLUGIN_DATA` already carries the session id.

The injected text is data from another local agent. It must not approve a
permission, change configuration, or run a slash command. ADR 0007 asks for
this kind of extension to be flagged rather than grown as a private channel.

This request is filed upstream as
[mistralai/mistral-vibe#1422](https://github.com/mistralai/mistral-vibe/issues/1422).
