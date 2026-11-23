maki lua plugins extend maki with tools, commands, keybindings, and event handlers. The plugin loads through the maki pack system, not as a builtin.

## Code guidelines

- Lua in `plugin/`. No trivial comments, minimal bloat, no unnecessary state.
- Keep the `MAX_*` constants at the top of the file.
- Fallible runtime operations return the `(value, err)` pair and never throw. Tool handlers fail with `{ llm_output = msg, is_error = true }`; a plain string is always success.
- Every tool that declares `permission_scopes` must also declare `permission`, and the capability must be granted in `plugin.toml`. maki refuses the load otherwise.
- `plugin.toml` grants exactly what the code calls. maki walks bundled plugins' lua and requires to keep manifests honest; keep ours aligned by hand.

## Testing

Run `just setup` once to install every host's dependencies at the versions the lockfiles pin. CI uses the same pins: bun `1.4.2`, TypeScript `7.0.2`, and `@types/bun` `1.4.5`. Keep the four `package.json` files and their lockfiles together when one moves.

The Rust checks run at the repository root. CI runs the same commands, see `.github/workflows/plugin.yml`. Cheapest first:

- `just check`
- `just lint`
- `just test`
- `just all` runs every Rust and host check in CI order

Tests live in `tests/` and load the plugin through the real `maki-lua` host with `PluginHost::load_package`, passing the repo root (it derives `plugin/` itself; passing `plugin/` fails with `PackageEmpty`).

Each test gets its own process under `cargo nextest`, which is what lets `tests/peer_integration.rs` redirect the process-wide XDG environment at a temp dir. A second test in that binary would race the first under plain `cargo test`.

Dev-dependencies pin a revision of maki. Move the pin when the host changes what the plugin uses. A plain `cargo update` can pull `monty` 1.6, which the pinned maki host does not compile against; dependabot ignores those three crates until the maki pin moves.

Assert Lua-visible effects (callback output, mailbox messages), not just files. `smol::unblock` side effects land even when a callback aborts, so file-only checks can pass while the Lua-level API is broken.

The OpenCode half in `opencode/` is checked separately:

- `cd opencode && bun test`
- `cd opencode && bunx tsc --noEmit`

Its tests drive the spool directly and assert the text handed to a session, which is that side's equivalent of a mailbox message. `src/spool.ts`, `src/peer.ts`, `src/protocol.ts`, and `src/receive.ts` hold the protocol and must not reference the plugin context, so they stay testable without a host. The Grok half vendors copies under `grok/src/shared`, because installing that plugin copies only its own directory, and a test requires the copies to match.

The Grok half in `grok/` is checked separately:

- `cd grok && bun test`
- `cd grok && bunx tsc --noEmit`

Its tests assert the text a hook prints and the spool files that text came from. The hook script and the TypeScript resolve the runtime directory the same way, and a test locks that.

The Vibe half in `vibe/` is checked separately:

- `cd vibe && bun test`
- `cd vibe && bunx tsc --noEmit`

Its tests assert the hook stdout and the spool files that text came from. The hook script resolves `PLUGIN_DATA` and `MAKI_PEER_SPOOL` the same way the server does. `vibe/src/shared` is a copy of the host-free spool modules, and a test requires the copy to match.

The Claude Code half in `claude/` is checked separately:

- `cd claude && bun test`
- `cd claude && bunx tsc --noEmit`

Its tests assert the hook stdout, the spool files, the tool results, and the optional channel event. `claude/src/shared` is a byte-for-byte copy of the host-free spool modules, and a test requires the copy to match. The marketplace manifest at the repository root points at `claude/`.

## Layout

- `plugin/` — the maki plugin entry files, loaded sorted by file name; chunks share one environment.
- `plugin.toml` — `min_maki_version` and the `[permissions]` request.
- `tests/` — host harness and integration tests.
- `opencode/` — the opencode plugin, its own `README.md`, and its tests.
- `grok/` — the Grok plugin (hooks, a skill, and an MCP server), its own `README.md`, and its tests. `src/shared` is a copy of the host-free spool modules.
- `vibe/` — the Vibe plugin (hooks, a skill, and an MCP server), its own `README.md`, and its tests. `src/shared` is a copy of the host-free spool modules. `upstream-issue.md` is the request for idle delivery.
- `claude/` — the Claude Code plugin (hooks, a skill, and an MCP server), its own `README.md`, and its tests. `src/shared` is a copy of the host-free spool modules.
- `.claude-plugin/marketplace.json` — the local marketplace that installs `claude/`.
- `justfile` — check, lint, test, and the per-host suites.

## The spool

The five hosts write presence records to `owners/<peer-id>.json` and messages to `inboxes/<peer-id>/<message-id>.json` under one per-user directory. The maki half resolves that directory through `maki.env.state_dir()`, and the opencode half through `resolveSpoolRoot` in `opencode/src/spool.ts`. The grok, vibe, and claude halves use `resolveSpoolRoot` too, with `MAKI_PEER_SPOOL` as a test override. They must agree, including maki's rule that a `~/.maki` directory takes over every path when it exists. The id prefixes are `mk-`, `oc-`, `gk-`, `vb-`, and `cc-`.

Grok keeps its own runtime files in a `grok-peer` directory beside the spool root: session state, the helper's port and heartbeat, and mail that is waiting for another Grok session. Claude keeps its runtime files in `claude-peer` beside the spool root. Those files are not protocol records. Vibe keeps its session state in the per-session `PLUGIN_DATA` directory Vibe assigns, which is also not a protocol record.

Three rules keep the hosts compatible. Records carry `origin.host`, and a `session` field is honoured only when it names the reading host's own id format, because an id means nothing on the other side. A message that can never be delivered, because it names a session or host that is gone, is dropped and logged rather than retried until it expires. The `wake` field is written by every host, but only Maki and Claude Code start a turn from it; the tool description says hosts differ, so keep the five copies equal when it changes.

## Docs

The README is the canonical home for install and usage. Follow the maki docs voice: plain words, no em-dashes, no contractions, state facts once.
