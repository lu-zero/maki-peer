# Coordinate peers through lanes

A **lane** is one unit of work: one issue, one worktree, one task branch, one
owner. The coordinator (this session) holds the plan. Peers never coordinate
with each other; each reports to the coordinator only.

Use this skill in this order. Each step names the command that does it.

## 1. Roll call before every dispatch

Never dispatch onto an assumption about what is live. Run, in parallel:

- `{{PEER_LIST}}`:
  who exists, which directory each is anchored in, and whether it is
  `working` or `idle`.
- `git worktree list --porcelain`, then for each worktree `rev-parse --abbrev-ref
  HEAD`, `status --porcelain | wc -l`, and `log -1 --format='%h %cr'`: the
  lanes on disk, their branch, dirtiness and age.
- `gh pr view <N> --json state,mergeStateStatus,headRefOid` for every PR the
  lanes own, and `git log --oneline <old-main>..<new-main>` after a fetch.

Join the three by directory and branch. A peer whose lane's PR shows `MERGED`
is retired, not retasked in place. A peer missing from `{{PEER_LIST}}` has
left; read its `PROCESS.md` to see how far it got before it went.

A peer that is `idle` is not done. Idle means it is waiting for a message and
will act on the next one it receives, so a message to an idle peer is a
dispatch.

## 2. Lane record

Each lane keeps `PROCESS.md` at a path agreed at dispatch, for example
`.agents/evidence/<lane-id>-<date>/PROCESS.md`. The record has:

- A header: lane ID, worktree, branch, base SHA, coordinator peer ID, inputs.
- `Status:` from a fixed set: `IN_PROGRESS`, `NEEDS_DECISION`,
  `NEEDS_CONTEXT`, `BLOCKED`, `STOPPED`, `DONE`.
- A timestamped, append-only `## Steps` section. Every command and its
  verbatim output goes there.

Read this file when a peer reports, and when a peer goes quiet. A header with
no steps is a peer that stalled after it started.

## 3. Dispatch contract

A dispatch message states all of:

| Field | Content |
|---|---|
| Goal | one sentence |
| Context | spec path, row ID, base SHA, inputs with hashes |
| Scope | exact files or directories it may change |
| Exclusions | what it must not touch, including "no push, no PR" when true |
| Constraints | build recipe, CPU-only or GPU lease, thread counts |
| Completion | the gate that must pass, with the command |
| Evidence | what to write, where |
| Output contract | `DONE` with evidence, `NEEDS_DECISION`, or `NEEDS_CONTEXT` |
| Stop conditions | when to stop instead of expanding scope |

Two rules carry most of the value:

- **Scope is fixed.** When the work needed is larger than the dispatch says,
  the peer returns `NEEDS_DECISION` and stops. The coordinator does not let a
  peer turn a fix into a new feature.
- **Verify the gap first.** Before dispatching an implementation, grep the base
  tree for the symbol or file. A dispatch to "run and fix" a path that does not
  exist wastes a build and returns `NEEDS_DECISION`.

## 4. Answering a peer

| Peer says | Coordinator does |
|---|---|
| `DONE` with evidence | Rerun the gate itself. Dispatch a fresh reviewer. |
| `NEEDS_DECISION` | Decide, or ask the user when it is a product or authority decision. Reply with numbered decisions and the new `Status` to set. |
| `NEEDS_CONTEXT` | Send the missing context by path. Never let the peer guess. |
| Stalled, no steps | Read `PROCESS.md`, rerun what can be rerun, then redispatch or retire. |
| Silent and gone from `peer_list` | Treat the lane as unowned. Close its record with the finding. |

## 5. Retire a lane

When the PR merges, or the lane is abandoned:

1. Tell the peer to set `Status: STOPPED` or `DONE` and end.
2. `git worktree remove --force <path>` and `git branch -D <branch>` from the
   main checkout. An untracked `PROCESS.md` goes with the worktree, so note its
   content in memory first when it holds a finding.
3. Confirm with `git worktree list`.

The shared checkout stays on a clean `main`. Never edit, commit or stash in it.

Squash merges leave a branch that is not an ancestor of `main`, so
`merge-base --is-ancestor` is the wrong test. Check `gh pr list --state all
--head <branch>` instead. When a branch has no PR of its own, remove the
worktree and the local branch only, and leave the copy on your fork remote so
it stays recoverable.

## Reviewers are not lanes

A review-only peer is a stateless subagent. It owns no worktree after it
removes its scratch copy, and it has no `PROCESS.md`. A stand-down message to
a reviewer asks only for acknowledgement, never for a `Status` change. Asking
one anyway costs a round trip in which the peer searches for a record that
does not exist.

## Tool notes

- `{{PEER_SEND}}` takes `kind`, `topic` and `message`. The result says only
  that the message was queued, not that the peer read it. The tool description
  says when `{{PEER_BROADCAST}}` is the right call.
- `pgrep -f` and `pkill -f` match the calling shell when the pattern appears in
  your own command. Use `pgrep -x <name>`.
{{HARNESS_NOTES}}

## Dispatch message template

```
<coordinator peer id>, lane <LANE-ID>

Goal: <one sentence>
Context: spec <path>, row <ID>, worktree <path>, base <sha>, inputs <path + hash>
Scope: <files or directories>
Exclusions: <what not to touch; no push/PR/merge>
Constraints: <build recipe, CPU only / flock ~/gpu.lock, -j N>
Completion: <gate command> exits 0
Evidence: write <path>, verbatim commands and output
Report: DONE with evidence | NEEDS_DECISION | NEEDS_CONTEXT, to <coordinator peer id> only
Stop when: <condition>. Do not expand scope.
Status: keep PROCESS.md Status current from the fixed set.
```

## Status query template

```
<coordinator peer id>, roll call <date>, status check only.
Reply to <coordinator peer id> with a STATUS message of at most 10 lines:
what you concluded, where the evidence is, and your current Status.
Do not start new work. Do not edit, commit, push or open anything.
```
