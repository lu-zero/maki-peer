import { existsSync, rmSync, statSync } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { MAX_RECORD_BYTES } from "./protocol.js"

export type SpoolOptions = {
  /** Absolute override for the spool root, used by tests and odd setups. */
  spoolRoot?: string
  home?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Maki resolves its state directory one of two ways: a `~/.maki` directory
 * takes over every path when it exists, otherwise the XDG state directory is
 * used. Mirror that exactly, or the two hosts read different spools.
 */
export function resolveSpoolRoot(options: SpoolOptions = {}): string {
  if (options.spoolRoot) return options.spoolRoot
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const fallback = join(home, ".maki")
  if (existsSync(fallback) && statSync(fallback).isDirectory()) return join(fallback, "peers")
  const stateBase = env.XDG_STATE_HOME ? env.XDG_STATE_HOME : join(home, ".local", "state")
  return join(stateBase, "maki", "peers")
}

export class Spool {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  ownerPath(id: string): string {
    return join(this.root, "owners", `${id}.json`)
  }

  ownersDir(): string {
    return join(this.root, "owners")
  }

  inboxPath(id: string): string {
    return join(this.root, "inboxes", id)
  }

  async prepare(): Promise<void> {
    await mkdir(this.ownersDir(), { recursive: true })
    await mkdir(join(this.root, "inboxes"), { recursive: true })
  }

  /**
   * Write through a temporary file so a reader never sees a half-written
   * record. This is the same guarantee `maki.fs.atomic_write` gives.
   */
  async write(path: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw new Error(`record is too large: ${path}`)
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      await writeFile(temp, body, "utf8")
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Returns undefined for a missing, oversized, or unparsable file. */
  async read(path: string): Promise<unknown> {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined
      return JSON.parse(await readFile(path, "utf8")) as unknown
    } catch {
      return undefined
    }
  }

  async listJson(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(dir, entry.name))
    } catch {
      return []
    }
  }

  async ensureInbox(id: string): Promise<string> {
    const dir = this.inboxPath(id)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true })
  }

  /** Best effort for teardown, which cannot await. */
  removeSync(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch {
      /* a leftover record ages out once the stale window passes */
    }
  }
}
