# Plugin hooks cannot deliver text into an idle turn

The maki-peer plugin lets a Vibe session discover Maki, OpenCode, and Grok
sessions on the same machine and exchange short observations with them. The
package is Agent Plugins 1.0: an MCP server, a skill, and the three public
hooks. It does not need a new discovery mechanism, and it does not patch the
harness.

## What a live session on 2.26.0 showed

Headless Vibe 2.26.0, with the package trusted in the workdir and the spool
pointed at a temp directory:

- The MCP server speaks one JSON object per line. `mcp_peer.peer_list` and
  `mcp_peer.peer_send` ran. The send wrote an observation whose
  `origin.host` is `vibe`.
- The three hooks in `ai.mistral.vibe/hooks.toml` were pinned with the
  package and did not run. Session state never gained a working directory,
  the presence record stayed `idle`, and an observation queued for that
  peer was not appended to the tool result.

`_foreign_hook_definitions` in 2.26 reads `result.hooks` from project and
user `hooks.toml` and skips `result.runtime_hooks`. The v3.0.4 notes say a
native plugin's `ai.mistral.vibe/hooks.toml` now runs from the session copy,
with `PLUGIN_ROOT` and `PLUGIN_DATA` set. This request assumes that release.
It was not re-run here, because the installed binary is still 2.26.0.

## What is still closed on v3.0.4

`HookType` is `post_agent`, `pre_tool`, and `post_tool`. Mail that arrives
while the session is idle sits in the inbox until some later tool call. A
turn that finishes without calling a tool never sees mail that arrived
during that turn. `post_agent` can accept the turn or, with
`decision = "deny"`, ask for a retry. It cannot append text. Using deny to
carry ordinary mail would force a revision of a turn the user already
finished. A failed `post_agent` hook accepts, so it cannot be the delivery
path either.

Observations expire after 300 seconds. An idle session can lose the message
before the next tool call.

## The primitives that would close it

Both already exist behind the plugin surface. Checked on the v3.0.4 tree.

1. `pre_agent_turn` can continue with `user_content`. That is the text the
   next turn should see. A plugin `hooks.toml` cannot declare that point.
   The public hook set is still `pre_tool`, `post_tool`, and `post_agent`.

2. `session/turn/enqueue` accepts one future turn and promotes it when the
   session is idle and unpaused. An attached client can call it. The MCP
   server a session bound cannot. The queue is process-local and is
   discarded on stop, which is a fine lifetime for this mail.

## Request

Expose one of those to a plugin.

The smaller change is a hook, fired as a turn is about to start, whose
stdout can supply `user_content`. It needs to run for a turn that starts
because the session was idle, not only for a turn the user just typed.
Empty stdout would mean "add nothing", the same way `post_tool` treats
empty stdout today.

The other change is a way for the MCP server a session bound to enqueue one
turn on that session. The server already knows the session, because
`PLUGIN_DATA` contains the session id.

The injected text is data from another local agent. It must not approve a
permission, change configuration, or run a slash command. The plugin will
keep labelling it as an observation the model can ignore.

A new invocation mechanism is the sort of extension ADR 0007 asks to flag
rather than grow a private channel for. Happy to adjust the plugin to
whichever of the two surfaces you would rather support.
