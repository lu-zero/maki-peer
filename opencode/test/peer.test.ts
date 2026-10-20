import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GC_MARK_AFTER_SECONDS, MAX_TITLE_RUNES, NAME_HEX_WIDTH, kindOf, parseMessage, parseOwner, sameTree, titleOf, validId, type Owner } from "../src/protocol.js"
import {
  applyEvent,
  applyEventAsync,
  broadcastTo,
  deliveryText,
  formatPeerLines,
  messageRecord,
  nameFromPeerID,
  peerIdFor,
  statusFor,
  PeerRegistry,
  resolvePeer,
  topicOf,
  sweepOrphanInboxes, sweepStaleOwners,
  type ResolveResult,
} from "../src/peer.js"
import { resolveSpoolRoot, Spool } from "../src/spool.js"
import { fakeHost, inbox, makiRecord, owners, tempRoot, writeRecord } from "./harness.js"

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
const files = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return [] as string[]
  }
}

describe("spool root", () => {
  test("uses the XDG state directory when no fallback exists", () => {
    const home = tempRoot()
    expect(resolveSpoolRoot({ home, env: {} })).toBe(join(home, ".local/state/maki/peers"))
    expect(resolveSpoolRoot({ home, env: { XDG_STATE_HOME: "/tmp/xdg" } })).toBe("/tmp/xdg/maki/peers")
  })

  test("lets a ~/.maki directory take over, matching maki's own resolution", () => {
    const home = tempRoot()
    mkdirSync(join(home, ".maki"), { recursive: true })
    expect(resolveSpoolRoot({ home, env: {} })).toBe(join(home, ".maki/peers"))
    expect(resolveSpoolRoot({ home, env: { XDG_STATE_HOME: "/tmp/xdg" } })).toBe(join(home, ".maki/peers"))
  })

  test("honours an explicit override", () => {
    expect(resolveSpoolRoot({ spoolRoot: "/somewhere/peers" })).toBe("/somewhere/peers")
  })
})

describe("spool writes", () => {
  test("replaces a record without leaving the temporary file behind", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const path = spool.ownerPath("peer-1")
    await spool.write(path, { protocol: 1, id: "peer-1" })
    await spool.write(path, { protocol: 1, id: "peer-1", name: "second" })
    expect(await spool.read(path)).toEqual({ protocol: 1, id: "peer-1", name: "second" })
    expect(owners(root)).toEqual(["peer-1.json"])
  })

  test("reports a missing or unparsable record as undefined rather than throwing", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    expect(await spool.read(join(root, "owners", "nope.json"))).toBeUndefined()
    writeFileSync(join(root, "owners", "bad.json"), "{not json")
    expect(await spool.read(join(root, "owners", "bad.json"))).toBeUndefined()
  })
})

describe("record parsing", () => {
  test("accepts ids maki would accept and rejects the rest", () => {
    expect(validId("peer-6ad0c541-38dcc5aadf6-6977506e")).toBe(true)
    expect(validId("oc-0123456789abcdef")).toBe(true)
    expect(validId("ses_9c1b08")).toBe(true)
    expect(validId("not/a/peer")).toBe(false)
    expect(validId("../escape")).toBe(false)
    expect(validId("")).toBe(false)
    expect(validId(42)).toBe(false)
  })

  test("drops a presence record without a usable heartbeat", () => {
    expect(parseOwner({ protocol: 1, id: "a", name: "n", started: 1, last_seen: "soon" })).toBeUndefined()
    expect(parseOwner({ protocol: 2, id: "a", name: "n", started: 1, last_seen: 1 })).toBeUndefined()
    expect(parseOwner({ protocol: 1, id: "a", name: "n", started: 1, last_seen: 1 })?.id).toBe("a")
  })

  test("drops a message addressed to another peer", () => {
    const now = Math.floor(Date.now() / 1000)
    const base = { protocol: 1, id: "m1", from: "p1", body: "hi", kind: "observation", created: now, expires: now + 10 }
    expect(parseMessage({ ...base, to: "other" }, "mine")).toBeUndefined()
    expect(parseMessage({ ...base, to: "mine" }, "mine")?.id).toBe("m1")
  })

  test("drops a message whose body exceeds the cap", () => {
    const now = Math.floor(Date.now() / 1000)
    const body = "x".repeat(262145)
    const record = { protocol: 1, id: "m1", from: "p1", to: "mine", body, kind: "observation", created: now, expires: now + 10 }
    expect(parseMessage(record, "mine")).toBeUndefined()
  })
})

describe("presence records", () => {
  test("a peer id is stable for a session so a reload reuses the record", () => {
    expect(peerIdFor("ses_abc123")).toBe(peerIdFor("ses_abc123"))
    expect(peerIdFor("ses_abc123")).not.toBe(peerIdFor("ses_abc124"))
    expect(peerIdFor("ses_abc123")).toMatch(/^oc-[0-9a-f]{16}$/)
  })

  test("status aggregates the same three states maki reports", () => {
    expect(statusFor({ busy: false, waiting: false })).toBe("idle")
    expect(statusFor({ busy: true, waiting: false })).toBe("working")
    expect(statusFor({ busy: true, waiting: true })).toBe("needs_input")
    expect(statusFor({ busy: false, waiting: true })).toBe("needs_input")
  })

  test("the record names the host that wrote it", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    const [owner] = await host.registry.all()
    expect(owner?.origin?.host).toBe("opencode")
    expect(owner?.name).toBe(nameFromPeerID("opencode", peerIdFor("ses_oc_one")))
    expect(owner?.status).toBe("idle")
  })

  test("a retired session stops publishing and loses its record", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_one")
    await host.pump()
    expect(owners(root)).toContain(`${host.peerID}.json`)
    await host.registry.retire("ses_one")
    await host.pump()
    expect(owners(root)).not.toContain(`${host.peerID}.json`)
  })
})

describe("event folding", () => {
  const registry = () => new PeerRegistry(new Spool(tempRoot()), "opencode")

  test("any event carrying a session id registers that session as a peer", () => {
    const r = registry()
    // `session.created` and `session.status` are not emitted in every flow, so
    // registration must not depend on them.
    applyEvent(r, "session.inbox.enqueued", { sessionID: "ses_a" })
    expect(r.has("ses_a")).toBe(true)
    applyEvent(r, "session.execution.started", { sessionID: "ses_b" })
    expect(r.has("ses_b")).toBe(true)
  })

  test("an event with no session id is ignored", () => {
    const r = registry()
    applyEvent(r, "model.updated", {})
    applyEvent(r, "location.shutdown", {})
    expect(r.sessions()).toEqual([])
  })

  test("execution events drive the working state", () => {
    const r = registry()
    applyEvent(r, "session.inbox.enqueued", { sessionID: "ses_a" })
    expect(peerStatusOf(r, "ses_a")).toBe("idle")
    applyEvent(r, "session.execution.started", { sessionID: "ses_a" })
    expect(peerStatusOf(r, "ses_a")).toBe("working")
    applyEvent(r, "session.execution.succeeded", { sessionID: "ses_a" })
    expect(peerStatusOf(r, "ses_a")).toBe("idle")
    applyEvent(r, "session.execution.started", { sessionID: "ses_a" })
    applyEvent(r, "session.execution.interrupted", { sessionID: "ses_a" })
    expect(peerStatusOf(r, "ses_a")).toBe("idle")
  })

  test("a permission request outranks a running agent", () => {
    const r = registry()
    applyEvent(r, "session.execution.started", { sessionID: "ses_a" })
    applyEvent(r, "permission.asked", { sessionID: "ses_a" })
    expect(peerStatusOf(r, "ses_a")).toBe("needs_input")
    applyEvent(r, "permission.replied", { sessionID: "ses_a" })
    expect(peerStatusOf(r, "ses_a")).toBe("working")
  })

  test("a session status retry waits for the user", () => {
    const r = registry()
    applyEvent(r, "session.status", { sessionID: "ses_a", status: { type: "retry" } })
    expect(peerStatusOf(r, "ses_a")).toBe("needs_input")
    applyEvent(r, "session.status", { sessionID: "ses_a", status: { type: "idle" } })
    expect(peerStatusOf(r, "ses_a")).toBe("idle")
  })

  test("a model change reaches the presence record", async () => {
    const root = tempRoot()
    const r = new PeerRegistry(new Spool(root), "opencode")
    applyEvent(r, "session.inbox.enqueued", { sessionID: "ses_a" })
    applyEvent(r, "session.model.selected", { sessionID: "ses_a", model: { providerID: "zai", id: "glm-5" } })
    await r.flush(0)
    const [owner] = await r.all()
    expect(owner?.model).toBe("zai/glm-5")
  })

  test("a deleted session loses its record", async () => {
    const root = tempRoot()
    const r = new PeerRegistry(new Spool(root), "opencode")
    applyEvent(r, "session.inbox.enqueued", { sessionID: "ses_a" })
    await r.flush(0)
    expect(owners(root).length).toBe(1)
    await applyEventAsync(r, "session.deleted", { sessionID: "ses_a" })
    expect(r.has("ses_a")).toBe(false)
    expect(owners(root).length).toBe(0)
  })

  test("a deleted session takes its inbox with it, so its mail is not stranded", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    const r = new PeerRegistry(spool, "opencode")
    applyEvent(r, "session.inbox.enqueued", { sessionID: "ses_a" })
    await r.flush(0)
    const peerId = r.idFor("ses_a")!
    const dir = await spool.ensureInbox(peerId)
    await spool.write(join(dir, "m1.json"), { body: "undelivered" })
    await applyEventAsync(r, "session.deleted", { sessionID: "ses_a" })
    expect(existsSync(dir)).toBe(false)
  })
})

function peerStatusOf(registry: PeerRegistry, sessionID: string): string | undefined {
  const peer = registry.get(sessionID)
  return peer ? statusFor({ busy: peer.busy, waiting: peer.waiting }) : undefined
}

describe("sender identity", () => {
  test("a session sends under its own id, not another session's", () => {
    const r = new PeerRegistry(new Spool(tempRoot()), "opencode")
    // One plugin instance tracks every session at its location, so more than
    // one peer is present when a tool runs.
    r.observe("ses_first")
    r.observe("ses_second")
    r.setBusy("ses_first", true)
    expect(r.idFor("ses_second")).toBe(peerIdFor("ses_second"))
    expect(r.idFor("ses_first")).toBe(peerIdFor("ses_first"))
    expect(r.idFor("ses_second")).not.toBe(r.idFor("ses_first"))
  })

  test("an untracked session still gets a stable id", () => {
    const r = new PeerRegistry(new Spool(tempRoot()), "opencode")
    r.observe("ses_first")
    expect(r.idFor("ses_unseen")).toBe(peerIdFor("ses_unseen"))
    expect(r.idFor("ses_unseen")).toBe(r.idFor("ses_unseen"))
  })

  test("an invalid session id yields nothing rather than a shared fallback", () => {
    const r = new PeerRegistry(new Spool(tempRoot()), "opencode")
    r.observe("ses_first")
    expect(r.idFor("not/a/session")).toBeUndefined()
    expect(r.nameFor("not/a/session")).toBeUndefined()
  })

  test("the name is derived from the peer id, not the session, so it survives a reload", () => {
    const r = new PeerRegistry(new Spool(tempRoot()), "opencode")
    r.observe("ses_abcdef")
    expect(r.nameFor("ses_abcdef")).toBe(nameFromPeerID("opencode", peerIdFor("ses_abcdef")))
    expect(r.nameFor("ses_abcdef")).toBe(r.nameFor("ses_abcdef"))
    // An untracked session still gets a name, and it is the same one the peer id
    // gives, so addressing does not depend on the registry having seen it.
    expect(r.nameFor("ses_zzzzzz")).toBe(nameFromPeerID("opencode", peerIdFor("ses_zzzzzz")))
    expect(r.nameFor("ses_abcdef")).not.toBe(r.nameFor("ses_zzzzzz"))
  })

  test("a name is the host plus eight hex of the peer id", () => {
    expect(nameFromPeerID("maki", "peer-6ac003aa-28e1e6e9573-7ded469b")).toBe("maki-6ac003aa")
    expect(nameFromPeerID("opencode", "oc-072f2841ee0e9743")).toBe("opencode-072f2841")
    // The width is a shared constant, not a habit that drifts per half.
    expect(nameFromPeerID("maki", "peer-6ac003aa")).toBe(`maki-${"6ac003aa".slice(0, NAME_HEX_WIDTH)}`)
    expect(nameFromPeerID("maki", "peer-6ac003aa")).toHaveLength("maki".length + 1 + NAME_HEX_WIDTH)
  })
})

describe("delivery", () => {
  test("a maki record reaches the owning session even though its session id is foreign", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    writeRecord(root, host.peerID, makiRecord({ id: "m1", from: "peer-maki", to: host.peerID, body: "hello", session: "some-maki-uuid" }))
    await host.pump()
    expect(host.delivered).toEqual([{ sessionID: "ses_oc_one", text: "[peer peer-maki] hello" }])
    expect(inbox(root, host.peerID)).toEqual([])
  })

  test("a maki record with no session still lands on the owning session", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    writeRecord(root, host.peerID, makiRecord({ id: "m1", from: "peer-maki", to: host.peerID, body: "no address" }))
    await host.pump()
    expect(host.delivered.map((item) => item.text)).toEqual(["[peer peer-maki] no address"])
  })

  test("an address for a session this host no longer runs is dropped, not retried", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    writeRecord(
      root,
      host.peerID,
      makiRecord({ id: "m1", from: "peer-opencode", to: host.peerID, body: "gone", session: "ses_gone", origin: "opencode" }),
    )
    await host.pump()
    expect(host.delivered).toEqual([])
    expect(inbox(root, host.peerID)).toEqual([])
  })

  test("an address from this host for another session it runs is honoured", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_a")
    // One host runs two sessions, each with its own inbox, as a real
    // opencode service does for one project.
    const secondPeer = host.registry.observe("ses_b")
    await host.pump()
    writeRecord(
      root,
      host.peerID,
      makiRecord({ id: "m1", from: "peer-opencode", to: host.peerID, body: "cross", session: "ses_b", origin: "opencode" }),
    )
    await host.pump()
    expect(host.delivered).toEqual([{ sessionID: "ses_b", text: "[peer peer-opencode] cross" }])
    expect(inbox(root, host.peerID)).toEqual([])
    expect(secondPeer?.id).not.toBe(host.peerID)
  })

  test("an expired record is dropped without reaching a session", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    writeRecord(root, host.peerID, makiRecord({ id: "m1", from: "peer-maki", to: host.peerID, body: "old", ttl: -10 }))
    await host.pump()
    expect(host.delivered).toEqual([])
    expect(inbox(root, host.peerID)).toEqual([])
  })

  test("a record addressed to another peer is dropped rather than looped over forever", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    writeRecord(root, host.peerID, makiRecord({ id: "m1", from: "peer-maki", to: "someone-else", body: "not mine" }))
    await host.pump()
    expect(host.delivered).toEqual([])
    // A misfiled record can never be delivered by any poller, since each reads
    // only its own inbox, so leaving it would re-read it every pass forever.
    expect(inbox(root, host.peerID)).toEqual([])
  })

  test("a torn file is dropped rather than looped over, because both writers are atomic", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    const path = join(root, "inboxes", host.peerID, "m1.json")
    mkdirSync(join(root, "inboxes", host.peerID), { recursive: true })
    writeFileSync(path, "{partial")
    await host.pump()
    expect(host.delivered).toEqual([])
    expect(files(join(root, "inboxes", host.peerID))).toEqual([])
  })
})

describe("cross-host exchange", () => {
  test("two opencode sessions on one spool each see the other", async () => {
    const root = tempRoot()
    const first = fakeHost(root, "opencode", "ses_first")
    const second = fakeHost(root, "opencode", "ses_second")
    await first.pump()
    await second.pump()

    const all = await first.registry.all()
    expect(all.map((owner) => owner.id).sort()).toEqual([first.peerID, second.peerID].sort())
    expect(all.every((owner) => owner.status === "idle")).toBe(true)

    writeRecord(root, second.peerID, makiRecord({ id: "x1", from: first.peerID, to: second.peerID, body: "first speaks" }))
    await second.pump()
    expect(second.delivered).toEqual([{ sessionID: "ses_second", text: `[peer ${first.peerID}] first speaks` }])
    expect(inbox(root, second.peerID)).toEqual([])
  })

  test("retiring one peer hides it from the other", async () => {
    const root = tempRoot()
    const first = fakeHost(root, "opencode", "ses_first")
    const second = fakeHost(root, "opencode", "ses_second")
    await first.pump()
    await second.pump()
    expect((await first.registry.all()).length).toBe(2)
    await first.registry.retire("ses_first")
    expect((await second.registry.all()).length).toBe(1)
  })

  test("a maki peer joins the same list", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    writeRecord(root, "unused", makiRecord({ id: "m1", from: "peer-maki", to: host.peerID, body: "x" }))
    const makiPath = join(root, "owners", "peer-maki.json")
    writeFileSync(
      makiPath,
      JSON.stringify({
        protocol: 1,
        id: "peer-maki",
        name: "maki-peer-6ad0c541",
        started: Math.floor(Date.now() / 1000),
        last_seen: Math.floor(Date.now() / 1000),
        status: "working",
        model: "zai/glm-5.3-flash",
      }),
    )
    const all = await host.registry.all()
    const maki = all.find((owner) => owner.id === "peer-maki")
    expect(maki?.status).toBe("working")
    expect(maki?.model).toBe("zai/glm-5.3-flash")
    expect(maki?.origin?.host).toBeUndefined()
    expect(read(makiPath).protocol).toBe(1)
  })
})

describe("peer resolution", () => {
  const now = 1_700_000_000
  const oc = (lastSeen = now): Owner => ({
    protocol: 1,
    id: "oc-072f2841ee0e9743",
    name: "opencode:3H0d7w",
    started: 0,
    last_seen: lastSeen,
    status: "idle",
    origin: { host: "opencode" },
  })
  const maki = (): Owner => ({
    protocol: 1,
    id: "peer-6acbcdda-34204583840-7fa08a12",
    name: "maki-peer-6acbcdda",
    started: 0,
    last_seen: now,
    status: "idle",
    origin: { host: "maki" },
  })
  const id = (result: ResolveResult) => (result as { peer: Owner }).peer.id
  const error = (result: ResolveResult) => (result as { error: string }).error

  test("takes the id out of the list", () => {
    expect(id(resolvePeer([oc(), maki()], "oc-072f2841ee0e9743", now))).toBe("oc-072f2841ee0e9743")
  })

  test("takes a full name, colon and all", () => {
    expect(id(resolvePeer([oc(), maki()], "opencode:3H0d7w", now))).toBe("oc-072f2841ee0e9743")
    expect(id(resolvePeer([oc(), maki()], "maki-peer-6acbcdda", now))).toBe("peer-6acbcdda-34204583840-7fa08a12")
  })

  test("takes the bare fragment a reader copies out of the list", () => {
    expect(id(resolvePeer([oc(), maki()], "3H0d7w", now))).toBe("oc-072f2841ee0e9743")
    expect(id(resolvePeer([oc(), maki()], "6acbcdda", now))).toBe("peer-6acbcdda-34204583840-7fa08a12")
  })

  test("takes an id prefix", () => {
    expect(id(resolvePeer([oc(), maki()], "peer-6acbc", now))).toBe("peer-6acbcdda-34204583840-7fa08a12")
  })

  test("answers a typo with the alternatives rather than claiming the peer is gone", () => {
    const result = resolvePeer([oc(), maki()], "3H0d7X", now)
    expect(error(result)).toStartWith('no live peer matches "3H0d7X"')
    expect(error(result)).toContain("opencode:3H0d7w [oc-072f2841ee0e9743]")
  })

  test("names the candidates when a fragment is ambiguous", () => {
    const twin = { ...oc(), id: "oc-072f2841ee0e9744" }
    expect(error(resolvePeer([oc(), twin], "opencode:3H0d7w", now))).toStartWith('"opencode:3H0d7w" matches 2 peers')
  })

  test("reports an exited peer by age instead of as a typo", () => {
    const result = resolvePeer([oc(now - 60), maki()], "3H0d7w", now)
    expect(error(result)).toContain("last refreshed 60s ago")
    expect(error(result)).toContain("it may have exited")
  })

  test("requires a target", () => {
    expect(error(resolvePeer([oc()], "   ", now))).toBe("a peer name or id is required")
  })

  test("a host is not its own peer", () => {
    const mine = { ...oc(), id: "oc-self", name: "opencode-self" }
    // Resolution drops it, so sending to yourself is refused rather than looping
    // a message back into your own session.
    expect(error(resolvePeer([mine, maki()], "oc-self", now, new Set(["oc-self"])))).toContain("maki-peer-6acbcdda")
    // And it is not offered as an answer to anybody else's typo either.
    const suggestions = error(resolvePeer([mine, maki()], "zzz", now, new Set(["oc-self"])))
    expect(suggestions).not.toContain("opencode-self")
    expect(suggestions).toContain("maki-peer-6acbcdda")
  })

  test("never turns an exited pile into a wall of text", () => {
    const graveyard = Array.from({ length: 200 }, (_, index) => ({
      ...oc(now - 3600),
      id: `peer-dead-${index}`,
      name: `maki-peer-dead${index}`,
    }))
    const message = error(resolvePeer([...graveyard, oc(), maki()], "peer-dead-", now))
    expect(message).toStartWith("peer maki-peer-dead0 [peer-dead-0] last refreshed 3600s ago")
    expect(message).toContain("200 exited peers match")
    expect(message.split(" ").length).toBeLessThan(30)
  })

  test("prefers the live peer over an exited one matching the same fragment", () => {
    const dead = { ...oc(now - 3600), id: "peer-dead", name: "maki-peer-6ad1d6c6" }
    expect(id(resolvePeer([dead, maki(), oc()], "6acbcdda", now))).toBe("peer-6acbcdda-34204583840-7fa08a12")
  })

  test("answers one exited peer by age even when dead records share its name", () => {
    const dead = { ...oc(now - 90), id: "peer-1", name: "maki-peer-6ad1d6c6" }
    const older = { ...oc(now - 400), id: "peer-2", name: "maki-peer-6ad1d6c6" }
    expect(error(resolvePeer([dead, older, oc(), maki()], "6ad1d6c6", now))).toContain("last refreshed 90s ago")
  })
})

describe("peer list lines", () => {
  const oc: Owner = {
    protocol: 1,
    id: "oc-072f2841ee0e9743",
    name: "opencode-072f2841",
    started: 0,
    last_seen: 0,
    status: "working",
    model: "opencode/space-bunny-free",
    origin: { host: "opencode" },
  }

  test("leads with the abbreviated id the send tool takes", () => {
    const [line] = formatPeerLines([oc], { ids: new Set() })
    expect(line).toBe("- oc-0  working  opencode/space-bunny-free  -  via opencode")
  })

  test("cuts the title for width and says so, the record keeping the full form", () => {
    const titled = { ...oc, title: "reviewer: watching the provider retry path" }
    const [line] = formatPeerLines([titled], { ids: new Set() })
    expect(line).toBe(
      "- oc-0  working  opencode/space-bunny-free  reviewer: watching the p\u2026  via opencode",
    )
  })

  test("tags only the exceptions", () => {
    const mine = { ...oc, id: peerIdFor("ses_me"), cwd: "/home/u/src/maki-peer" }
    const neighbour = { ...oc, id: "oc-2", cwd: "/home/u/src/maki-peer/" }
    const elsewhere = { ...oc, id: "oc-3", cwd: "/home/u/src/other" }
    const lines = formatPeerLines([mine, neighbour, elsewhere], { ids: new Set([mine.id]), cwd: "/home/u/src/maki-peer", sessionID: "ses_me" })
    expect(lines[0]).toEndWith("  (you)")
    expect(lines[1]).toBe("- oc-2  working  opencode/space-bunny-free  -  via opencode")
    expect(lines[2]).toEndWith("  (other dir)")
  })

  test("leaves same dir off the reader, who is always in their own", () => {
    const mine = { ...oc, id: peerIdFor("ses_me"), cwd: "/home/u" }
    const lines = formatPeerLines([mine], { ids: new Set([mine.id]), cwd: "/home/u", sessionID: "ses_me" })
    expect(lines[0]).toEndWith("  (you)")
  })

  test("marks the session that asked, which the host cannot single out", () => {
    const mine = { ...oc, id: peerIdFor("ses_me"), cwd: "/home/u" }
    const sibling = { ...oc, id: peerIdFor("ses_other") }
    const lines = formatPeerLines([mine, sibling], { ids: new Set([mine.id, sibling.id]), sessionID: "ses_me" })
    expect(lines[0]).toContain("(you)")
    expect(lines[1]).not.toContain("(you)")
    expect(lines[1]).not.toContain("(other dir)")
  })

  test("prints a dash for a peer that names no model", () => {
    expect(formatPeerLines([{ ...oc, model: undefined }], { ids: new Set() })[0]).toContain("  -  ")
  })

  test("prints a dash for a peer with no title", () => {
    expect(formatPeerLines([{ ...oc, title: undefined }], { ids: new Set() })[0]).toContain("  -  via")
  })

  test("widens abbreviations until the ids differ", () => {
    const a = { ...oc, id: "oc-abc123def4567890" }
    const b = { ...oc, id: "oc-abc123def4567899" }
    const lines = formatPeerLines([a, b], { ids: new Set() })
    for (const line of lines) {
      const shown = line.slice(2).split("  ")[0]
      expect(shown.length).toBeGreaterThan(4)
    }
  })

  test("says so when this host is alone", () => {
    expect(formatPeerLines([oc], { ids: new Set([oc.id]) })).toEqual([
      expect.stringContaining("oc-0"),
      "No other local peers are registered.",
    ])
  })
})

describe("titles", () => {
  test("survives the round trip through a presence record", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const registry = new PeerRegistry(spool)
    registry.observe("ses_one")
    registry.setDetail("ses_one", { title: "reviewer: provider retry path" })
    await registry.flush(0)
    expect(read(spool.ownerPath(registry.ids()[0] as string)).title).toBe("reviewer: provider retry path")
  })

  test("a newline cannot inject a fake list row", () => {
    expect(titleOf("legit\n- oc-fake  idle  -  -  via maki")).toBe("legit - oc-fake idle - - via maki")
  })

  test("control characters and tab runs are flattened, not just newlines", () => {
    expect(titleOf("a\t\tb")).toBe("a b")
    expect(titleOf("a\u001b[31mred\u001b[0m")).toBe("a [31mred [0m")
  })

  test("the cap is counted in runes, so a code point is never split", () => {
    // Sixty four runes of "e" followed by combining accents is sixty four
    // graphemes but far more bytes; the cap must cut at a code point boundary.
    const wide = "e".repeat(70)
    expect([...(titleOf(wide) as string)].length).toBe(MAX_TITLE_RUNES)
    const unicode = "e\u0301".repeat(MAX_TITLE_RUNES + 5)
    expect([...(titleOf(unicode) as string)].every((rune) => rune === "e" || rune === "\u0301")).toBe(true)
  })

  test("blank means absent, not an empty string on the wire", () => {
    expect(titleOf("   ")).toBeUndefined()
    expect(titleOf(undefined)).toBeUndefined()
    expect(titleOf(42)).toBeUndefined()
  })

  test("a detail update that changes nothing leaves the record clean", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const registry = new PeerRegistry(spool)
    registry.observe("ses_one")
    registry.setDetail("ses_one", { title: "same", cwd: "/same" })
    await registry.flush(0)
    const before = read(spool.ownerPath(registry.ids()[0] as string)).last_seen as number
    registry.setDetail("ses_one", { title: "same", cwd: "/same" })
    await registry.flush(5000)
    expect(read(spool.ownerPath(registry.ids()[0] as string)).last_seen).toBe(before)
  })
})

describe("working directory", () => {
  test("survives the round trip through a presence record", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const registry = new PeerRegistry(spool)
    registry.observe("ses_one")
    registry.setDetail("ses_one", { cwd: "/home/u/src/maki-peer" })
    await registry.flush(0)
    const id = registry.ids()[0] as string
    expect(read(spool.ownerPath(id)).cwd).toBe("/home/u/src/maki-peer")
    expect((await registry.all())[0]?.cwd).toBe("/home/u/src/maki-peer")
  })

  test("is per session, so two sessions of one host can differ", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const registry = new PeerRegistry(spool)
    registry.observe("ses_one")
    registry.observe("ses_two")
    registry.setDetail("ses_one", { cwd: "/home/u/src/a" })
    registry.setDetail("ses_two", { cwd: "/home/u/src/b" })
    await registry.flush(0)
    const paths = (await registry.all()).map((owner) => owner.cwd)
    expect(paths.sort()).toEqual(["/home/u/src/a", "/home/u/src/b"])
  })

  test("is absent when the host cannot report one", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const registry = new PeerRegistry(spool)
    registry.observe("ses_one")
    await registry.flush(0)
    expect(read(spool.ownerPath(registry.ids()[0] as string)).cwd).toBeUndefined()
  })

  test("ignores a trailing slash and never matches a host that reports none", () => {
    expect(sameTree({ cwd: "/a/b" }, { cwd: "/a/b/" })).toBe(true)
    expect(sameTree({ cwd: "/a/b" }, { cwd: "/a/c" })).toBe(false)
    expect(sameTree({ cwd: "/a/b" }, {})).toBe(false)
    expect(sameTree({}, {})).toBe(false)
  })
})

describe("surviving a reload", () => {
  const publish = async (root: string, instance: string, sessionID: string) => {
    const spool = new Spool(root)
    await spool.prepare()
    const registry = new PeerRegistry(spool, "opencode", { instance })
    registry.observe(sessionID, "opencode/space-bunny-free")
    await registry.flush(0)
    return spool
  }

  test("takes a session back from its own record", async () => {
    const root = tempRoot()
    const spool = await publish(root, "opencode-abc", "ses_quiet")

    // A reload is a new registry over the same spool with nothing observed.
    const after = new PeerRegistry(spool, "opencode", { instance: "opencode-abc" })
    expect(after.sessions()).toEqual([])
    expect(after.reclaim(await after.records())).toBe(1)

    expect(after.sessions()).toEqual(["ses_quiet"])
    expect(after.idFor("ses_quiet")).toBe(peerIdFor("ses_quiet"))
    await after.flush(0)
    expect(owners(root)).toEqual([`${peerIdFor("ses_quiet")}.json`])
  })

  test("keeps the uptime the session had before the reload", async () => {
    const root = tempRoot()
    const spool = await publish(root, "opencode-abc", "ses_quiet")
    const before = read(spool.ownerPath(peerIdFor("ses_quiet"))).started as number

    const after = new PeerRegistry(spool, "opencode", { instance: "opencode-abc" })
    after.reclaim(await after.records())
    expect(after.get("ses_quiet")?.started).toBe(before)
  })

  test("leaves another instance's sessions alone", async () => {
    const root = tempRoot()
    await publish(root, "opencode-other", "ses_theirs")
    const mine = new PeerRegistry(new Spool(root), "opencode", { instance: "opencode-mine" })
    expect(mine.reclaim(await mine.records())).toBe(0)
    expect(mine.sessions()).toEqual([])
  })

  test("ignores its own older records, which name no session", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    await spool.write(spool.ownerPath("oc-old"), {
      protocol: 1,
      id: "oc-old",
      name: "opencode:older",
      started: 1,
      last_seen: Math.floor(Date.now() / 1000),
      status: "idle",
      instance: "opencode-abc",
    })
    const registry = new PeerRegistry(spool, "opencode", { instance: "opencode-abc" })
    expect(registry.reclaim(await registry.records())).toBe(0)
  })

  test("reclaims nothing when the instance cannot be identified", async () => {
    const root = tempRoot()
    const spool = await publish(root, "opencode-abc", "ses_quiet")
    const anon = new PeerRegistry(spool)
    expect(anon.reclaim(await anon.records())).toBe(0)
  })
})

/**
 * The shared fixture. Both halves read this file and assert the same
 * expectations, so a rule that drifts on one side only is a parity defect
 * rather than two suites that each agree with themselves.
 */
const PARITY_CASES: { name: string; input: string; expected: string | null }[] = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "parity", "sanitising.json"), "utf8"),
).cases

test("the topic sanitising matches the shared fixture", () => {
  expect(PARITY_CASES.length).toBeGreaterThan(0)
  for (const c of PARITY_CASES) {
    expect(topicOf(c.input), c.name).toBe(c.expected ?? undefined)
  }
})

test("gives a receiving session the sender name before the id, one space apart", () => {
  expect(deliveryText({ from_name: "opencode:3H0d7w", from: "oc-072f2841ee0e9743", body: "ping" })).toBe(
    "[peer opencode:3H0d7w oc-072f2841ee0e9743] ping",
  )
})

test("a topic leads the body, and a message without one is unchanged", () => {
  expect(
    deliveryText({
      from_name: "opencode-072f2841",
      from: "oc-072f2841ee0e9743",
      topic: "box state",
      body: "the sweep finishes at about 22:52",
    }),
  ).toBe("[peer opencode-072f2841 oc-072f2841ee0e9743] box state: the sweep finishes at about 22:52")
  expect(
    deliveryText({ from_name: "opencode-072f2841", from: "oc-072f2841ee0e9743", body: "ping" }),
  ).toBe("[peer opencode-072f2841 oc-072f2841ee0e9743] ping")
})

test("a topic is sanitised on the way out, because the other half may be older", () => {
  expect(
    deliveryText({
      from_name: "opencode-072f2841",
      from: "oc-072f2841ee0e9743",
      topic: "  box\u0001 state   here  ",
      body: "ping",
    }),
  ).toBe("[peer opencode-072f2841 oc-072f2841ee0e9743] box state here: ping")
  // A topic that is only whitespace is no topic at all.
  expect(
    deliveryText({
      from_name: "opencode-072f2841",
      from: "oc-072f2841ee0e9743",
      topic: "   \u0001  ",
      body: "ping",
    }),
  ).toBe("[peer opencode-072f2841 oc-072f2841ee0e9743] ping")
})

test("a cut that lands on a space keeps it, so both halves print the same bytes", () => {
  // The maki half cuts at the rune boundary and keeps a space that lands on
  // it. The opencode half used to trim the end after the cut, which made the
  // two halves differ by one byte.
  const topic = "x".repeat(47) + " more text"
  const printed = deliveryText({
    from_name: "opencode-072f2841",
    from: "oc-072f2841ee0e9743",
    topic,
    body: "ping",
  })
  expect(printed).toBe(`[peer opencode-072f2841 oc-072f2841ee0e9743] ${"x".repeat(47)} : ping`)
})

test("a topic is capped at 48 runes, on a rune boundary", () => {
  const topic = "\u{2014}".repeat(60)
  const printed = deliveryText({
    from_name: "opencode-072f2841",
    from: "oc-072f2841ee0e9743",
    topic,
    body: "ping",
  })
  expect(printed).toBe(`[peer opencode-072f2841 oc-072f2841ee0e9743] ${"\u{2014}".repeat(48)}: ping`)
  // The topic is 48 runes, and the cut did not split one: every em dash in the
  // printed line is whole, and there are exactly 48 of them.
  expect([...printed].filter((c) => c === "\u{2014}").length).toBe(48)
})

test("the topic survives a round trip through the record", () => {
  const record = messageRecord({
    id: "m1",
    from: "oc-072f2841ee0e9743",
    fromName: "opencode-072f2841",
    to: "oc-peer",
    body: "ping",
    kind: "observation",
    topic: "box state",
  })
  expect(record.topic).toBe("box state")
  const parsed = parseMessage(record, "oc-peer")
  expect(parsed?.topic).toBe("box state")
})

test("a message without a topic has no topic field at all", () => {
  const record = messageRecord({
    id: "m1",
    from: "oc-072f2841ee0e9743",
    fromName: "opencode-072f2841",
    to: "oc-peer",
    body: "ping",
    kind: "observation",
  })
  expect("topic" in record).toBe(false)
  expect(parseMessage(record, "oc-peer")?.topic).toBe(undefined)
})

describe("mark and sweep", () => {
  const now = 1_700_000_000
  const write = async (spool: Spool, id: string, lastSeen: number, name = `maki-${id}`) => {
    await spool.write(spool.ownerPath(id), {
      protocol: 1,
      id,
      name,
      started: 1,
      last_seen: lastSeen,
      status: "idle",
    })
  }
  const setup = async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const records = async () => new PeerRegistry(spool).records()
    return { root, spool, records }
  }

  test("marks and deletes a record that is still long past the horizon", async () => {
    const { spool, records } = await setup()
    await write(spool, "peer-dead", now - 3600)
    const report = await sweepStaleOwners({ spool, records: await records(), ownIDs: new Set(), now })
    expect(report.marked).toBe(1)
    expect(report.deleted).toBe(1)
    expect(await records()).toEqual([])
  })

  test("keeps a record that refreshed between the mark and the sweep", async () => {
    const { spool, records } = await setup()
    await write(spool, "peer-slow", now - 3600)
    const stale = await records()

    // The peer comes back between the two phases of one pass.
    await write(spool, "peer-slow", now)

    const report = await sweepStaleOwners({ spool, records: stale, ownIDs: new Set(), now })
    expect(report.deleted).toBe(0)
    expect(report.kept).toBe(1)
    expect((await records()).map((owner) => owner.id)).toEqual(["peer-slow"])
  })

  test("takes an inbox whose owner is gone and that holds nothing", async () => {
    const { spool } = await setup()
    // The churn era left directories behind: an id that no longer has a record
    // and nothing in it. That is cruft and nothing else.
    const orphan = await spool.ensureInbox("peer-gone")
    const removed = await sweepOrphanInboxes({ spool, ownIDs: new Set() })
    expect(removed).toBe(1)
    expect(existsSync(orphan)).toBe(false)
  })

  test("leaves an inbox that still holds a message, owner or no owner", async () => {
    const { spool } = await setup()
    const orphan = await spool.ensureInbox("peer-gone")
    await spool.write(join(orphan, "m1.json"), { body: "waiting" })
    const removed = await sweepOrphanInboxes({ spool, ownIDs: new Set() })
    expect(removed).toBe(0)
    expect(existsSync(join(orphan, "m1.json"))).toBe(true)
  })

  test("leaves a claimed message alone, because a claim is a file in flight", async () => {
    const { spool } = await setup()
    const orphan = await spool.ensureInbox("peer-gone")
    await spool.write(join(orphan, "m1.json.opencode-1-abc.claim"), { body: "in flight" })
    const removed = await sweepOrphanInboxes({ spool, ownIDs: new Set() })
    expect(removed).toBe(0)
    expect(existsSync(join(orphan, "m1.json.opencode-1-abc.claim"))).toBe(true)
  })

  test("leaves an inbox whose owner is live, even when it holds nothing", async () => {
    const { spool } = await setup()
    await write(spool, "peer-live", now - 2)
    const live = await spool.ensureInbox("peer-live")
    const removed = await sweepOrphanInboxes({ spool, ownIDs: new Set() })
    expect(removed).toBe(0)
    expect(existsSync(live)).toBe(true)
  })

  test("leaves this host's own inbox alone", async () => {
    const { spool } = await setup()
    const own = await spool.ensureInbox("oc-self")
    const removed = await sweepOrphanInboxes({ spool, ownIDs: new Set(["oc-self"]) })
    expect(removed).toBe(0)
    expect(existsSync(own)).toBe(true)
  })

  test("takes the inbox with a record it deletes, message and all", async () => {
    const { spool, records } = await setup()
    await write(spool, "peer-dead", now - 3600)
    const inbox = await spool.ensureInbox("peer-dead")
    await spool.write(join(inbox, "m1.json"), { body: "hello" })
    const report = await sweepStaleOwners({ spool, records: await records(), ownIDs: new Set(), now })
    expect(report.deleted).toBe(1)
    expect(await records()).toEqual([])
    expect(existsSync(inbox)).toBe(false)
  })

  test("never removes this host's own inbox, even from a forged mark", async () => {
    const { spool } = await setup()
    await write(spool, "oc-self", now - 3600)
    const inbox = await spool.ensureInbox("oc-self")
    await spool.write(join(inbox, "m1.json"), { body: "mine" })
    await spool.write(spool.gcMarkPath("forged"), [{ id: "oc-self", last_seen: now - 3600 }])
    await sweepStaleOwners({ spool, records: [], ownIDs: new Set(["oc-self"]), now })
    expect(existsSync(inbox)).toBe(true)
    expect(existsSync(join(inbox, "m1.json"))).toBe(true)
  })

  test("never marks or deletes this host's own records", async () => {
    const { spool, records } = await setup()
    await write(spool, "oc-self", now - 3600)
    await write(spool, "peer-dead", now - 3600)
    const report = await sweepStaleOwners({ spool, records: await records(), ownIDs: new Set(["oc-self"]), now })
    expect(report.marked).toBe(1)
    expect(report.deleted).toBe(1)
    expect((await records()).map((owner) => owner.id)).toEqual(["oc-self"])
  })

  test("leaves a live record alone", async () => {
    const { spool, records } = await setup()
    await write(spool, "oc-live", now - 2)
    const report = await sweepStaleOwners({ spool, records: await records(), ownIDs: new Set(), now })
    expect(report.marked + report.deleted).toBe(0)
  })

  test("leaves an unreadable mark file in place rather than clearing the queue", async () => {
    const { root, spool, records } = await setup()
    await write(spool, "peer-dead", now - 3600)
    const torn = spool.gcMarkPath("torn")
    await spool.write(torn, [{ id: "peer-dead", last_seen: now - 3600 }])
    // A second writer truncated its file, which is what a torn write looks like.
    writeFileSync(torn, '[{"id":"peer-dead","last_se')

    // No records of our own, so the only mark in play is the torn one.
    const report = await sweepStaleOwners({ spool, records: [], ownIDs: new Set(), now })
    expect(report.unreadable).toBe(1)
    expect(report.deleted).toBe(0)
    expect(owners(root)).toContain("peer-dead.json")
    expect(readdirSync(join(root, "gc"))).toEqual(["torn.json"])
  })

  test("removes a mark file it acted on, so the queue does not grow", async () => {
    const { root, spool, records } = await setup()
    await write(spool, "peer-dead", now - 3600)
    await sweepStaleOwners({ spool, records: await records(), ownIDs: new Set(), markName: "first", now })
    expect(readdirSync(join(root, "gc"))).toEqual([])
  })

  test("processes a mark written by the other host", async () => {
    const { spool, records } = await setup()
    await write(spool, "peer-dead", now - 3600)
    await spool.write(spool.gcMarkPath("from-maki"), [{ id: "peer-dead", last_seen: now - 3600 }])
    const report = await sweepStaleOwners({ spool, records: [], ownIDs: new Set(), now })
    expect(report.deleted).toBe(1)
    expect(await records()).toEqual([])
  })
})

describe("claims", () => {
  const claimPath = (r: string, peerID: string, name: string, instance: string) =>
    join(r, "inboxes", peerID, `${name}.json.${instance}.claim`)

  test("a claimed message is invisible to another poller, which is the whole point", async () => {
    const r = tempRoot()
    const mine = fakeHost(r, "opencode", "ses_claimer")
    const path = join(r, "inboxes", mine.peerID, "m1.json")
    mkdirSync(join(r, "inboxes", mine.peerID), { recursive: true })
    writeFileSync(path, JSON.stringify(makiRecord({ id: "m1", from: "peer-maki", to: mine.peerID, body: "once" })))
    // The other poller claimed it first and is mid delivery.
    const claimed = claimPath(r, mine.peerID, "m1", "opencode-other-1")
    renameSync(path, claimed)

    await mine.pump()
    expect(mine.delivered).toEqual([])
    expect(existsSync(claimed)).toBe(true)
  })

  test("an abandoned claim goes back to the queue once it is old enough", async () => {
    const r = tempRoot()
    const mine = fakeHost(r, "opencode", "ses_claimer")
    const claimed = claimPath(r, mine.peerID, "m1", "opencode-dead-1")
    mkdirSync(join(r, "inboxes", mine.peerID), { recursive: true })
    writeFileSync(claimed, JSON.stringify(makiRecord({ id: "m1", from: "peer-maki", to: mine.peerID, body: "once" })))
    // Nothing has held this claim for a long time: its poller is gone.
    const stale = new Date(Date.now() - 120_000)
    utimesSync(claimed, stale, stale)

    await mine.pump()
    expect(mine.delivered.map((item) => item.text)).toEqual(["[peer peer-maki] once"])
    expect(existsSync(claimed)).toBe(false)
  })

  test("a fresh claim is never stolen, so exclusivity outlives a slow delivery", async () => {
    const r = tempRoot()
    const mine = fakeHost(r, "opencode", "ses_claimer")
    const claimed = claimPath(r, mine.peerID, "m1", "opencode-other-1")
    mkdirSync(join(r, "inboxes", mine.peerID), { recursive: true })
    writeFileSync(claimed, JSON.stringify(makiRecord({ id: "m1", from: "peer-maki", to: mine.peerID, body: "once" })))

    await mine.pump()
    expect(mine.delivered).toEqual([])
    expect(existsSync(claimed)).toBe(true)
  })

  test("a delivery that asks to retry goes back to the queue for any poller", async () => {
    const r = tempRoot()
    const mine = fakeHost(r, "opencode", "ses_claimer")
    mine.deliverOverride = () => "retry"
    writeRecord(r, mine.peerID, makiRecord({ id: "m1", from: "peer-maki", to: mine.peerID, body: "once" }))
    await mine.pump()
    expect(files(join(r, "inboxes", mine.peerID))).toEqual(["m1.json"])

    mine.deliverOverride = undefined
    await mine.pump()
    expect(mine.delivered.map((item) => item.text)).toEqual(["[peer peer-maki] once"])
    expect(inbox(r, mine.peerID)).toEqual([])
  })

  test("an unreadable claim survives passes and delivers once it can be read", async () => {
    const r = tempRoot()
    const mine = fakeHost(r, "opencode", "ses_claimer")
    mine.deliverOverride = () => "retry"
    writeRecord(r, mine.peerID, makiRecord({ id: "m1", from: "peer-maki", to: mine.peerID, body: "later" }))
    const path = join(r, "inboxes", mine.peerID, "m1.json")
    chmodSync(path, 0o000)

    // A read failure is transient, so the record goes back to the queue rather
    // than being dropped, and several passes in a row do not lose it.
    await mine.pump()
    await mine.pump()
    expect(mine.delivered).toEqual([])
    expect(files(join(r, "inboxes", mine.peerID))).toEqual(["m1.json"])

    chmodSync(path, 0o644)
    mine.deliverOverride = undefined
    await mine.pump()
    expect(mine.delivered.map((item) => item.text)).toEqual(["[peer peer-maki] later"])
  })

  test("another poller's fresh claim is never read, so its content is never this poller's problem", async () => {
    const r = tempRoot()
    const mine = fakeHost(r, "opencode", "ses_claimer")
    const claimed = claimPath(r, mine.peerID, "m1", "opencode-other-1")
    mkdirSync(join(r, "inboxes", mine.peerID), { recursive: true })
    // Torn on purpose: if this poller read or deleted another poller's fresh
    // claim, it would be destroying a delivery that is still in flight.
    writeFileSync(claimed, "{partial")

    await mine.pump()
    expect(mine.delivered).toEqual([])
    expect(files(join(r, "inboxes", mine.peerID))).toEqual([`${claimed.slice(claimed.lastIndexOf("/") + 1)}`])
  })
})

describe("the rules both halves share", () => {
  test("a kind nobody knows is refused, and an absent one is an observation", () => {
    expect(kindOf(undefined)).toBe("observation")
    expect(kindOf("")).toBe("observation")
    expect(kindOf("observation")).toBe("observation")
    expect(kindOf("status")).toBe("status")
    expect(() => kindOf("note")).toThrow("kind must be observation or status")
  })

  test("a rejected message is not counted as queued", async () => {
    const peers = [
      { id: "oc-1", name: "one" },
      { id: "oc-2", name: "two" },
      { id: "oc-3", name: "three" },
    ] as Owner[]
    const queued = await broadcastTo(peers, async (peer) =>
      peer.id === "oc-2" ? { error: "the body is too large" } : { id: "m1", peer: peer.id },
    )
    // The middle one was rejected, so it is not on its way.
    expect(queued).toBe(2)
  })

  test("a directory is the same directory however many slashes end it", () => {
    expect(sameTree({ cwd: "/home/agent/project" }, { cwd: "/home/agent/project/" })).toBe(true)
    expect(sameTree({ cwd: "/home/agent/project//" }, { cwd: "/home/agent/project" })).toBe(true)
    expect(sameTree({ cwd: "/" }, { cwd: "/" })).toBe(true)
    expect(sameTree({ cwd: "/home/agent/project" }, { cwd: "/home/agent/other" })).toBe(false)
    // A peer that reports no directory is not in the same tree as anybody.
    expect(sameTree({}, { cwd: "/home/agent/project" })).toBe(false)
  })
})
