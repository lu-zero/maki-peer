import { dirname, join } from "node:path"

import { resolveSpoolRoot } from "./shared/spool.ts"

/**
 * Runtime files live beside the spool, never inside it. Owners and inboxes are
 * protocol records; session state and the daemon lock are not. The hook script
 * computes the same path.
 */
export function runtimeDir(spoolRoot: string): string {
  return join(dirname(spoolRoot), "claude-peer")
}

/** `MAKI_PEER_SPOOL` overrides the directory, for tests and odd setups. */
export function spoolRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAKI_PEER_SPOOL) return env.MAKI_PEER_SPOOL
  return resolveSpoolRoot({
    ...(env.HOME ? { home: env.HOME } : {}),
    env,
  })
}

/** Channel mode is opt in. Hook delivery stays the default. */
export function channelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAKI_PEER_CHANNELS === "1"
}
