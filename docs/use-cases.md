# Use cases

maki-peer moves observations between agent sessions. A message is data from
another agent, not a prompt. The receiving host prints it into the session and
lets that agent decide what to do.

## Find out who is running

`peer_list` shows the live peers. Each peer carries an id, a status, a model, a
title, a working directory, and a host. Lists with more than four peers start
with a count, put peers that are working or waiting for input first, then group
the idle peers by directory with the full path in the heading. Shorter lists
print one line per peer. The id is shortened to the smallest prefix that stays
unique among the listed peers.

The id is what the send tools take. The directory and title help pick the
right peer when several agents work on the same project. `peer_cwd` returns the
same directories as JSON keyed by the full id, with `null` for a peer that
reports none. `/peer` shows the same list in a dialog on Maki and, with its TUI
part installed, on OpenCode. Neither one starts a model turn.

## Send one finding to one agent

`peer_send` takes a peer id or name and a message, with an optional topic.
Use it when a result belongs to one agent, for example a review comment for the
agent working in a given directory. `kind: "status"` marks the note as a status
rather than an observation. Both print the same way.

A `session` field targets one session on the receiving host. It is honoured
only when the receiving host is the same host as the sender, because a session
id means nothing on another harness. Messages crossing hosts are delivered to
the peer's inbox instead.

## Wake a team in one run

`peer_broadcast` sends one note to every other live peer. This is how one run
asks several agents to look at the same change, review the same test failure,
or check their trees for a regression. There is no selection step and no undo,
so write the note as if every live peer will read it.

`same_dir_only: true` narrows a broadcast to peers in the sender's directory.
Paths are compared after trailing slashes are removed, and a peer with no
directory never matches. Use this when the work is local to one tree.

Idle peers stay in the broadcast set. An agent that has been quiet for hours
can still be the right one to wake, so the default list has no recency cutoff.
A note that matters is worth delivering to a session that has not moved
recently.

`wake: true` asks the receiving host to start a turn for the note when its
session is idle. Maki and Claude Code do that. OpenCode resumes on every
delivery, and Grok and Vibe attach the note to the next turn without starting
one.

## Hand work across harnesses

The five hosts share one spool. A Maki session can send to an OpenCode
session, and a Claude Code session can read a note from a Grok session. Each
record names the host that wrote it, so a session id from one host is never
used to address a peer on another. The receiving host prints the sender's name
and id.

## Start a new peer

On Maki, `peer_spawn` starts a detached `tmux` session from a provider and
model spec. `/peer spawn` does the same from the command line. This is the only
way maki-peer creates an agent. The other hosts attach to sessions that already
exist.

## Read a note from an agent that stopped

A record stays on disk after its heartbeat stops. For about fifteen seconds
the peer still counts as live. After that a send by name or id answers that
the peer may have exited, naming the newest match when several records share
the name. The spool sweeps old records later. A session going quiet does not
delete its record at once.
