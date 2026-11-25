
- A peer is started by the user in its own directory. Ask for that directory
  instead of trying to spawn one.
- OpenCode resumes a session on every delivery, so a `wake` flag changes
  nothing here.
- The bash tool mangles `cd X; a; b`. Use its `workdir` parameter.
