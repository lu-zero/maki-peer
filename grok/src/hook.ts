import { spawn } from "node:child_process"
import { join } from "node:path"

import { handleEvent } from "./handle.ts"
import { runtimeDir, spoolRootFromEnv } from "./paths.ts"

/** One event, applied in this process. The shell uses this when the daemon is down. */
async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (raw === "") return
  let event: unknown
  try {
    event = JSON.parse(raw) as unknown
  } catch {
    return
  }
  const pid = Number(process.env.GROK_PID ?? process.ppid)
  const spoolRoot = spoolRootFromEnv()
  const reply = await handleEvent({
    event,
    grokPid: Number.isInteger(pid) ? pid : 0,
    spoolRoot,
    runtime: runtimeDir(spoolRoot),
  })
  if (reply) process.stdout.write(reply)
  const child = spawn(process.execPath, [join(import.meta.dir, "daemon.ts")], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()
}

if (import.meta.main) {
  await main()
}
