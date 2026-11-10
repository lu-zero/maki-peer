import { basename, dirname } from "node:path"

import { validId } from "./shared/protocol.ts"

export const ORIGIN_HOST = "vibe"
export const ID_PREFIX = "vb"
export const LABEL = "vibe"

/**
 * How much of a delivery a hook will attach. Vibe accepts a megabyte of
 * hook stdout. The cap here matches the other host that attaches mail to a
 * tool result, so a burst reads the same length on both.
 */
export const MAX_DELIVERY_CHARS = 9000

/** Vibe session ids. A path segment that fails this is not a session. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value) && validId(value)
}

/**
 * The session a bound plugin belongs to.
 *
 * `PLUGIN_DATA` for a bound session is
 * `<storage>/plugins/data/<session-id>/<plugin>`. The `data` directory is
 * what makes this the per-session root. The install-wide plugin-data
 * directory does not have that parent, and it is not a session id.
 */
export function sessionIdFromPluginData(pluginData: string): string | undefined {
  if (basename(dirname(dirname(pluginData))) !== "data") return undefined
  const sessionId = basename(dirname(pluginData))
  return isSessionId(sessionId) ? sessionId : undefined
}

/**
 * The hook stdin and `PLUGIN_DATA` have to name one session. A mismatch
 * means the process is not the session the event is for, and publishing
 * under either id would put presence on the wrong peer.
 */
export function sessionForHook(pluginData: string | undefined, claimed: string | undefined): string | undefined {
  if (!pluginData || !claimed || !isSessionId(claimed)) return undefined
  return sessionIdFromPluginData(pluginData) === claimed ? claimed : undefined
}
