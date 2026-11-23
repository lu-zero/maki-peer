import { runtimeDir, spoolRootFromEnv } from "./paths.ts"
import { deliveryText } from "./shared/peer.ts"
import { originHost, parseMessage, type PeerMessage } from "./shared/protocol.ts"
import { receiveOnce } from "./shared/receive.ts"
import { Spool } from "./shared/spool.ts"
import { actingSession, listStates, peerIdOf, pidAlive, type SessionState } from "./state.ts"

const POLL_MS = 1000
const WAKE_WINDOW_MS = 60_000
const MAX_WAKES_PER_SENDER = 6
const HOSTS = new Set(["maki", "opencode", "grok", "vibe", "claude"])

/** Two agents acknowledging each other must not be able to spend turns forever. */
export class WakeBudget {
  private readonly spent = new Map<string, number[]>()

  allows(sender: string, now: number): boolean {
    const recent = (this.spent.get(sender) ?? []).filter((at) => now - at < WAKE_WINDOW_MS)
    this.spent.set(sender, recent)
    return recent.length < MAX_WAKES_PER_SENDER
  }

  spend(sender: string, now: number): void {
    this.spent.set(sender, [...(this.spent.get(sender) ?? []), now])
  }
}

async function wakeSenders(spool: Spool, peerID: string, nowSeconds: number): Promise<Set<string>> {
  const senders = new Set<string>()
  for (const path of await spool.listJson(spool.inboxPath(peerID))) {
    const text = await spool.readText(path).catch(() => undefined)
    if (text === undefined) continue
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    const message = parseMessage(value, peerID)
    if (message?.wake && message.expires > nowSeconds && HOSTS.has(originHost(message))) senders.add(message.from)
  }
  return senders
}

/**
 * Print the inbox when it holds a wake from a sender within budget. Each line
 * starts a turn on an idle session, so a body is JSON encoded to stay one line
 * and cannot forge a second event. The other notes ride along in that turn.
 * `busy` is not consulted: an interrupted turn runs no Stop hook and leaves it
 * set, and Claude Code queues a monitor event for a turn already running.
 */
export async function wakeOnce(input: {
  spool: Spool
  runtime: string
  state: SessionState
  budget: WakeBudget
  write: (line: string) => Promise<void>
  now?: number
}): Promise<number> {
  const { spool, state, budget } = input
  if (state.waiting) return 0
  const now = input.now ?? Date.now()
  const peerID = peerIdOf(state.sessionId)
  await spool.ensureInbox(peerID)
  const due = [...(await wakeSenders(spool, peerID, Math.floor(now / 1000)))].filter((sender) => budget.allows(sender, now))
  if (due.length === 0) return 0
  const own = new Set((await listStates(input.runtime)).map((item) => item.sessionId))
  const report = await receiveOnce({
    spool,
    peerID,
    instance: `claude-monitor-${process.pid}`,
    host: "claude",
    addressing: { ownSession: state.sessionId, owns: (sessionID: string) => own.has(sessionID) },
    deliver: async (message: PeerMessage, target: string) => {
      if (!HOSTS.has(originHost(message)) || target !== state.sessionId) return "retry"
      await input.write(`${JSON.stringify(deliveryText(message))}\n`)
      return "delivered"
    },
  })
  if (report.delivered > 0) for (const sender of due) budget.spend(sender, now)
  return report.delivered
}

function writeLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (error) => (error ? reject(error) : resolve()))
  })
}

async function main(): Promise<void> {
  const spoolRoot = spoolRootFromEnv()
  const runtime = runtimeDir(spoolRoot)
  const spool = new Spool(spoolRoot)
  await spool.prepare()
  const pid = Number(process.env.CLAUDE_PID ?? process.ppid)
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID
  const budget = new WakeBudget()
  process.stdout.on("error", () => process.exit(0))
  while (pidAlive(pid)) {
    // A resumed session has a new id, and only the process still names it.
    let state = await actingSession(runtime, { pid, ...(sessionId ? { sessionId } : {}) })
    if ("error" in state) state = await actingSession(runtime, { pid })
    if (!("error" in state)) await wakeOnce({ spool, runtime, state, budget, write: writeLine }).catch(() => {})
    await Bun.sleep(POLL_MS)
  }
}

if (import.meta.main) {
  await main()
}
