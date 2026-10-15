import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseMessage, parseOwner, validId } from "../src/protocol.js"
import { peerIdFor, statusFor } from "../src/peer.js"
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
