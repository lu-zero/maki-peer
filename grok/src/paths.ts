import { dirname, join } from "node:path"

import { resolveSpoolRoot } from "./shared/spool.ts"

/**
 * The directory beside the spool where this host keeps its own runtime files.
 *
 * Owners and inboxes stay the shared protocol. Session state, the daemon port,
 * and pending deliveries are not records another host reads, so they live next
 * to the spool rather than inside it. `bin/hook` computes the same path.
 */
export function runtimeDir(spoolRoot: string): string {
  return join(dirname(spoolRoot), "grok-peer")
}

/** `MAKI_PEER_SPOOL` overrides the directory, for tests and odd setups. */
export function spoolRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAKI_PEER_SPOOL) return env.MAKI_PEER_SPOOL
  return resolveSpoolRoot({
    ...(env.HOME ? { home: env.HOME } : {}),
    env,
  })
}
