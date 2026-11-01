import { resolveSpoolRoot } from "./shared/spool.ts"

/** `MAKI_PEER_SPOOL` overrides the directory, for tests and odd setups. */
export function spoolRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAKI_PEER_SPOOL) return env.MAKI_PEER_SPOOL
  return resolveSpoolRoot({
    ...(env.HOME ? { home: env.HOME } : {}),
    env,
  })
}
