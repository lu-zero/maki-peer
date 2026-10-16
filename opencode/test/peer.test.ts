import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseMessage, parseOwner, sameTree, validId, type Owner } from "../src/protocol.js"
import {
  applyEvent,
  applyEventAsync,
  formatPeerLines,
  peerIdFor,
  resolvePeer,
  statusFor,
  PeerRegistry,
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
    expect(owner?.name).toBe("opencode:oc_one")
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

  test("the name falls back to the session suffix when untracked", () => {
    const r = new PeerRegistry(new Spool(tempRoot()), "opencode")
    r.observe("ses_abcdef")
    expect(r.nameFor("ses_abcdef")).toBe("opencode:abcdef")
    expect(r.nameFor("ses_zzzzzz")).toBe("opencode:zzzzzz")
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

  test("a record addressed to another peer is left untouched", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    writeRecord(root, host.peerID, makiRecord({ id: "m1", from: "peer-maki", to: "someone-else", body: "not mine" }))
    await host.pump()
    expect(host.delivered).toEqual([])
    expect(inbox(root, host.peerID)).toEqual(["m1.json"])
  })

  test("a message already queued is not lost when the reader sees it mid-write", async () => {
    const root = tempRoot()
    const host = fakeHost(root, "opencode", "ses_oc_one")
    await host.pump()
    const path = join(root, "inboxes", host.peerID, "m1.json")
    mkdirSync(join(root, "inboxes", host.peerID), { recursive: true })
    writeFileSync(path, "{partial")
    await host.pump()
    expect(host.delivered).toEqual([])
    expect(files(join(root, "inboxes", host.peerID))).toEqual(["m1.json"])
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
    expect(error(result)).toStartWith('no peer matches "3H0d7X"')
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
    name: "opencode:3H0d7w",
    started: 0,
    last_seen: 0,
    status: "working",
    model: "opencode/space-bunny-free",
    origin: { host: "opencode" },
  }

  test("leads with the id the send tool takes", () => {
    const [line] = formatPeerLines([oc], { ids: new Set() })
    expect(line).toBe("- oc-072f2841ee0e9743  working  opencode/space-bunny-free  opencode:3H0d7w  via opencode")
  })

  test("marks this host and peers in the same directory", () => {
    const mine = { ...oc, cwd: "/home/u/src/maki-peer" }
    const neighbour = { ...oc, id: "oc-1", cwd: "/home/u/src/maki-peer/" }
    const elsewhere = { ...oc, id: "oc-2", cwd: "/home/u/src/other" }
    const lines = formatPeerLines([mine, neighbour, elsewhere], { ids: new Set([mine.id]), cwd: "/home/u/src/maki-peer" })
    expect(lines[0]).toEndWith("  (local)  (same dir)")
    expect(lines[1]).toEndWith("  (same dir)")
    expect(lines[2]).toEndWith("  via opencode")
  })

  test("leaves same dir off the reader, who is always in their own", () => {
    const mine = { ...oc, id: peerIdFor("ses_me"), cwd: "/home/u" }
    const lines = formatPeerLines([mine], { ids: new Set([mine.id]), cwd: "/home/u", sessionID: "ses_me" })
    expect(lines[0]).toEndWith("  (you)  (local)")
  })

  test("marks the session that asked, which local cannot single out", () => {
    const mine = { ...oc, id: peerIdFor("ses_me"), cwd: "/home/u" }
    const sibling = { ...oc, id: peerIdFor("ses_other") }
    const lines = formatPeerLines([mine, sibling], { ids: new Set([mine.id, sibling.id]), sessionID: "ses_me" })
    expect(lines[0]).toContain("(you)")
    expect(lines[0]).toContain("(local)")
    expect(lines[1]).toContain("(local)")
    expect(lines[1]).not.toContain("(you)")
  })

  test("prints a dash for a peer that names no model", () => {
    expect(formatPeerLines([{ ...oc, model: undefined }], { ids: new Set() })[0]).toContain("  -  ")
  })

  test("says so when this host is alone", () => {
    expect(formatPeerLines([oc], { ids: new Set([oc.id]) })).toEqual([
      expect.stringContaining("oc-072f2841ee0e9743"),
      "No other local peers are registered.",
    ])
  })
})

describe("working directory", () => {
  test("survives the round trip through a presence record", async () => {
    const root = tempRoot()
    const spool = new Spool(root)
    await spool.prepare()
    const registry = new PeerRegistry(spool, "opencode", { cwd: "/home/u/src/maki-peer" })
    registry.observe("ses_one")
    await registry.flush(0)
    const id = registry.ids()[0] as string
    expect(read(spool.ownerPath(id)).cwd).toBe("/home/u/src/maki-peer")
    expect((await registry.all())[0]?.cwd).toBe("/home/u/src/maki-peer")
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
