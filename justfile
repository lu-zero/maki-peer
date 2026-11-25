default:
    @just --list

# Install every host's dependencies at the versions the lockfiles pin.
setup:
    cargo fetch
    for d in opencode grok vibe claude; do (cd "$d" && bun install --frozen-lockfile); done

# Point OpenCode at this checkout for both the server tools and /peer.
install-opencode:
    bun opencode/install.ts

# Assemble the lane skill from its common body and per-harness notes.
skills:
    bun skills/assemble.ts

# Fail in CI when a checked-in skill differs from its source.
skills-check:
    bun skills/assemble.ts --check

# Copy the Maki and OpenCode skills into the personal config directories.
install-skills:
    bun skills/assemble.ts --install

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
all: check lint test fmt skills-check opencode grok vibe claude

fmt:
    cargo fmt --all -- --check
    just fmt-lua
