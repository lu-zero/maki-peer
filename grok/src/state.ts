import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { nameFromPeerID, peerIdFor, PeerRegistry } from "../../opencode/src/peer.ts"
import { validId } from "../../opencode/src/protocol.ts"
import { Spool } from "../../opencode/src/spool.ts"

export const ORIGIN_HOST = "grok"
export const ID_PREFIX = "gk"
export const LABEL = "grok"

export type SessionState = {
  sessionId: string
  grokPid: number
  cwd?: string
  title?: string
  model?: string
  busy: boolean
  waiting: boolean
  started: number
  detailChecked: number
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sessionsDir(runtime: string): string {
  return join(runtime, "sessions")
}

function sessionPath(runtime: string, sessionId: string): string {
  return join(sessionsDir(runtime), `${sessionId}.json`)
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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
  } catch {
    return undefined
  }
}

function parseState(value: unknown): SessionState | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!validId(record.sessionId)) return undefined
  if (typeof record.grokPid !== "number" || !Number.isInteger(record.grokPid)) return undefined
  if (typeof record.started !== "number") return undefined
  return {
    sessionId: record.sessionId,
    grokPid: record.grokPid,
    ...(typeof record.cwd === "string" && record.cwd !== "" ? { cwd: record.cwd } : {}),
    ...(typeof record.title === "string" && record.title !== "" ? { title: record.title } : {}),
    ...(typeof record.model === "string" && record.model !== "" ? { model: record.model } : {}),
    busy: record.busy === true,
    waiting: record.waiting === true,
    started: record.started,
    detailChecked: typeof record.detailChecked === "number" ? record.detailChecked : 0,
  }
}

export async function loadState(runtime: string, sessionId: string): Promise<SessionState | undefined> {
  if (!validId(sessionId)) return undefined
  return parseState(await readJson(sessionPath(runtime, sessionId)))
}

export async function saveState(runtime: string, state: SessionState): Promise<void> {
  if (!validId(state.sessionId)) return
  await writeJson(sessionPath(runtime, state.sessionId), state)
}

export async function removeState(runtime: string, sessionId: string): Promise<void> {
  if (!validId(sessionId)) return
  await rm(sessionPath(runtime, sessionId), { force: true })
  await rm(pendingPath(runtime, sessionId), { force: true })
}

export async function listStates(runtime: string): Promise<SessionState[]> {
  let names: string[]
  try {
    names = await readdir(sessionsDir(runtime))
  } catch {
    return []
  }
  const states: SessionState[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const state = parseState(await readJson(join(sessionsDir(runtime), name)))
    if (state) states.push(state)
  }
  return states
}

export function peerIdOf(sessionId: string): string {
  return peerIdFor(sessionId, ID_PREFIX)
}

export function peerNameOf(sessionId: string): string {
  return nameFromPeerID(LABEL, peerIdOf(sessionId))
}

/** Write the presence record. The inbox is left in place for a later resume. */
export async function publish(spool: Spool, state: SessionState): Promise<void> {
  const registry = new PeerRegistry(spool, LABEL, {
    instance: `grok-${state.grokPid}`,
    idPrefix: ID_PREFIX,
    host: ORIGIN_HOST,
  })
  const peer = registry.observe(state.sessionId, state.model)
  if (!peer) return
  peer.started = state.started
  registry.setBusy(state.sessionId, state.busy)
  registry.setWaiting(state.sessionId, state.waiting)
  registry.setDetail(state.sessionId, { title: state.title, cwd: state.cwd })
  if (state.model) registry.setModel(state.sessionId, state.model)
  await registry.flush(0)
}

export async function unpublish(spool: Spool, sessionId: string): Promise<void> {
  if (!validId(sessionId)) return
  await spool.remove(spool.ownerPath(peerIdOf(sessionId)))
}

function pendingPath(runtime: string, sessionId: string): string {
  return join(runtime, "pending", `${sessionId}.json`)
}

export async function appendPending(runtime: string, sessionId: string, text: string): Promise<void> {
  if (!validId(sessionId)) return
  const path = pendingPath(runtime, sessionId)
  const existing = await readJson(path)
  const lines = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : []
  lines.push(text)
  await writeJson(path, lines)
}

export async function takePending(runtime: string, sessionId: string): Promise<string[]> {
  if (!validId(sessionId)) return []
  const path = pendingPath(runtime, sessionId)
  const existing = await readJson(path)
  await rm(path, { force: true })
  return Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : []
}

/**
 * The session a tool call is acting as.
 *
 * A hook knows its session. An MCP server does not, unless the host put the
 * id in the environment. The process that spawned the server is the fallback,
 * and it is unambiguous only when that process has one live session.
 */
export async function actingSession(
  runtime: string,
  hint: { pid: number; sessionId?: string },
): Promise<SessionState | { error: string }> {
  const live = (await listStates(runtime)).filter((state) => pidAlive(state.grokPid))
  if (hint.sessionId) {
    const found = live.find((state) => state.sessionId === hint.sessionId)
    if (found) return found
    return { error: "this grok session is not registered as a peer yet" }
  }
  const mine = live.filter((state) => state.grokPid === hint.pid)
  const only = mine[0]
  if (mine.length === 1 && only) return only
  if (mine.length > 1) {
    return { error: "several grok sessions share this process, and the tool call does not say which one asked" }
  }
  return { error: "this grok session is not registered as a peer yet" }
}
