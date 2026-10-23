import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { MAX_MODEL_RUNES, titleOf } from "./shared/protocol.ts"

export type SessionDetail = {
  title?: string
  model?: string
}

/**
 * Title and model live in the session store, not on the hook event.
 *
 * The group directory is the working directory run through encodeURIComponent.
 * A path that was stored under the long-name fallback is found by walking one
 * level, which is the same walk a resume does when the encoded name is a hash.
 */
export function readSummary(sessionId: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): SessionDetail {
  const home = env.GROK_HOME && env.GROK_HOME !== "" ? env.GROK_HOME : join(env.HOME ?? homedir(), ".grok")
  const root = join(home, "sessions")
  const direct = cwd ? join(root, encodeURIComponent(cwd), sessionId, "summary.json") : undefined
  const path = direct && existsSync(direct) ? direct : findSummary(root, sessionId)
  if (!path) return {}
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return {}
  }
  if (typeof value !== "object" || value === null) return {}
  const record = value as Record<string, unknown>
  const manual = record.title_is_manual === true && typeof record.title === "string" ? record.title : undefined
  const generated = typeof record.generated_title === "string" ? record.generated_title : undefined
  const model = typeof record.current_model_id === "string" ? record.current_model_id : undefined
  return {
    ...(titleOf(manual ?? generated) ? { title: titleOf(manual ?? generated) } : {}),
    ...(titleOf(model, MAX_MODEL_RUNES) ? { model: titleOf(model, MAX_MODEL_RUNES) } : {}),
  }
}

function findSummary(root: string, sessionId: string): string | undefined {
  let groups: string[]
  try {
    groups = readdirSync(root)
  } catch {
    return undefined
  }
  for (const group of groups) {
    const candidate = join(root, group, sessionId, "summary.json")
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
