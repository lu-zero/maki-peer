maki lua plugins extend maki with tools, commands, keybindings, and event handlers. The plugin loads through the maki pack system, not as a builtin.

## Code guidelines

- Lua in `plugin/`. No trivial comments, minimal bloat, no unnecessary state.
- Keep the `MAX_*` constants at the top of the file.
- Fallible runtime operations return the `(value, err)` pair and never throw. Tool handlers fail with `{ llm_output = msg, is_error = true }`; a plain string is always success.
- Every tool that declares `permission_scopes` must also declare `permission`, and the capability must be granted in `plugin.toml`. maki refuses the load otherwise.
- `plugin.toml` grants exactly what the code calls. maki walks bundled plugins' lua and requires to keep manifests honest; keep ours aligned by hand.

## Testing

The Rust checks run at the repository root. CI runs the same commands, see `.github/workflows/plugin.yml`. Cheapest first:

- `just check`
- `just lint`
- `just test`

Tests live in `tests/` and load the plugin through the real `maki-lua` host with `PluginHost::load_package`, passing the repo root (it derives `plugin/` itself; passing `plugin/` fails with `PackageEmpty`).

Each test gets its own process under `cargo nextest`, which is what lets `tests/peer_integration.rs` redirect the process-wide XDG environment at a temp dir. A second test in that binary would race the first under plain `cargo test`.

Dev-dependencies pin a revision of maki. Move the pin when the host changes what the plugin uses.

Assert Lua-visible effects (callback output, mailbox messages), not just files. `smol::unblock` side effects land even when a callback aborts, so file-only checks can pass while the Lua-level API is broken.

The OpenCode half in `opencode/` is checked separately:

- `cd opencode && bun test`
- `cd opencode && bunx tsc --noEmit`

Its tests drive the spool directly and assert the text handed to a session, which is that side's equivalent of a mailbox message. `src/spool.ts`, `src/peer.ts`, and `src/receive.ts` hold the protocol and must not reference the plugin context, so they stay testable without a host.

## Layout

- `plugin/` — the maki plugin entry files, loaded sorted by file name; chunks share one environment.
- `plugin.toml` — `min_maki_version` and the `[permissions]` request.
- `tests/` — host harness and integration tests.
- `opencode/` — the opencode plugin, its own `README.md`, and its tests.
- `justfile` — check, lint, test, fmt-lua.

## The spool

Both halves write presence records to `owners/<peer-id>.json` and messages to `inboxes/<peer-id>/<message-id>.json` under one per-user directory. The maki half resolves that directory through `maki.env.state_dir()`, the opencode half through `resolveSpoolRoot` in `opencode/src/spool.ts`. They must agree, including maki's rule that a `~/.maki` directory takes over every path when it exists.

Two rules keep the two hosts compatible. Records carry `origin.host`, and a `session` field is honoured only when it names the reading host's own id format, because an id means nothing on the other side. A message that can never be delivered, because it names a session or host that is gone, is dropped and logged rather than retried until it expires.

## Docs

The README is the canonical home for install and usage. Follow the maki docs voice: plain words, no em-dashes, no contractions, state facts once.
