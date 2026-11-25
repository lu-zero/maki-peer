
- A peer is started by the user in its own directory. Ask for that directory
  instead of trying to spawn one.
- Claude Code starts an idle session for a note with `wake: true`, so a status
  query can use it. A note without `wake` waits for the next turn.
- MCP tools use Claude's scoped names. The names below are the ones this skill
  uses; do not shorten them.
