default:
    @just --list

# Install every host's dependencies at the versions the lockfiles pin.
setup:
    cargo fetch
    for d in opencode grok vibe claude; do (cd "$d" && bun install --frozen-lockfile); done

check:
    cargo check --tests

lint:
    cargo clippy --tests -- -D warnings

test:
    cargo nextest run

fmt-lua:
    stylua plugin/

# One host at a time, matching the CI jobs.
opencode:
    cd opencode && bun install --frozen-lockfile && bunx tsc --noEmit && bun test

grok:
    cd grok && bun install --frozen-lockfile && bunx tsc --noEmit && bun test

vibe:
    cd vibe && bun install --frozen-lockfile && bunx tsc --noEmit && bun test

claude:
    cd claude && bun install --frozen-lockfile && bunx tsc --noEmit && bun test

# Everything CI runs, in the same order.
all: check lint test fmt opencode grok vibe claude

fmt:
    cargo fmt --all -- --check
    just fmt-lua
