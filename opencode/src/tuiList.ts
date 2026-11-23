import type { Owner } from "./protocol.js"

const MAX_FLOAT_TITLE_RUNES = 48
const MIN_ABBREV_CHARS = 4

/** One row in the host's select dialog. It styles the title and description. */
export type PeerOption = {
  title: string
  description: string
  value: string
  category?: string
}

function shortTitle(title: string | undefined): string {
  if (!title) return "-"
  const runes = Array.from(title)
  return runes.length > MAX_FLOAT_TITLE_RUNES ? `${runes.slice(0, MAX_FLOAT_TITLE_RUNES).join("")}\u2026` : title
}

function commonPrefix(a: string, b: string | undefined): number {
  if (!b) return 0
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1
  return n
}

/** The shortest prefix that separates each id from its neighbours. */
function abbreviations(peers: Owner[]): Map<string, string> {
  const sorted = peers.map((peer) => peer.id).sort()
  const widths = new Map<string, number>()
  sorted.forEach((id, index) => {
    const shared = Math.max(commonPrefix(id, sorted[index - 1]), commonPrefix(id, sorted[index + 1]))
    widths.set(id, Math.min(id.length, Math.max(MIN_ABBREV_CHARS, shared + 1)))
  })
  return new Map(sorted.map((id) => [id, id.slice(0, widths.get(id) ?? id.length)]))
}

const icon = (status: string): string => (status === "working" ? "●" : status === "needs_input" ? "!" : "·")

/** The id as it appears in the list. */
export function shortID(peers: Owner[], id?: string): string | undefined {
  if (!id) return undefined
  return abbreviations(peers).get(id)
}

/**
 * One selectable row per peer. The title carries the id, icon and harness on
 * the first line and the session title on the second. The host puts the
 * category, the working directory, on the right of the first line.
 */
export function peerOptions(peers: Owner[], ownID?: string): PeerOption[] {
  const abbrev = abbreviations(peers)
  const short = peers.map((peer) => abbrev.get(peer.id) ?? peer.id)
  const width = Math.max(...short.map((name) => name.length), 0)

  return peers.map((peer, index) => {
    const name = short[index]
    const tag = peer.id === ownID ? " (you)" : ""
    const host = peer.origin?.host ?? "maki"
    const title = `${name.padEnd(width)}  ${icon(peer.status)} ${host}  ${shortTitle(peer.title)}${tag}`
    return { title, description: "", value: peer.id, category: peer.cwd }
  })
}
