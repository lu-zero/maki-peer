import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { isSessionId } from "./identity.ts"

export type SessionState = {
  sessionId: string
  cwd?: string
  busy: boolean
  started: number
}

function statePath(pluginData: string): string {
  return join(pluginData, "state.json")
}

const LOCK_STALE_MS = 5000

/**
 * The hook and the MCP server are different processes and both rewrite the
 * same state file. `mkdir` is the lock. A lock older than a few seconds is
 * dropped, so a killed hook cannot leave the session stuck.
 */
export async function withStateLock<T>(pluginData: string, job: () => Promise<T>): Promise<T> {
  const lock = join(pluginData, "state.lock")
  await mkdir(pluginData, { recursive: true })
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const info = await stat(lock).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  try {
    return await job()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value))
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

function parseState(value: unknown, sessionId: string): SessionState | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.sessionId !== sessionId) return undefined
  if (typeof record.started !== "number" || !Number.isFinite(record.started)) return undefined
  return {
    sessionId,
    ...(typeof record.cwd === "string" && record.cwd !== "" ? { cwd: record.cwd } : {}),
    busy: record.busy === true,
    started: record.started,
  }
}

export async function loadState(pluginData: string, sessionId: string): Promise<SessionState | undefined> {
  if (!isSessionId(sessionId)) return undefined
  try {
    const value = JSON.parse(await readFile(statePath(pluginData), "utf8")) as unknown
    return parseState(value, sessionId)
  } catch {
    return undefined
  }
}

/** Create the state on first use and keep `started` across later updates. */
export async function updateState(
  pluginData: string,
  sessionId: string,
  patch: { cwd?: string; busy?: boolean },
): Promise<SessionState | undefined> {
  if (!isSessionId(sessionId)) return undefined
  const existing = await loadState(pluginData, sessionId)
  const next: SessionState = {
    sessionId,
    busy: patch.busy ?? existing?.busy ?? false,
    started: existing?.started ?? Math.floor(Date.now() / 1000),
  }
  const cwd = patch.cwd ?? existing?.cwd
  if (cwd) next.cwd = cwd
  await writeJson(statePath(pluginData), next)
  return next
}
