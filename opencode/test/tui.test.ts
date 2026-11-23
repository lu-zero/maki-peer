import { describe, expect, test } from "bun:test"

import { peerIdFor } from "../src/peer.js"
import { parseMessage, type Owner } from "../src/protocol.js"
import { Spool } from "../src/spool.js"
import { peerOptions } from "../src/tuiList.js"
import { queuePeerMessage } from "../src/tuiSend.js"
import { tempRoot } from "./harness.js"

const owner = (id: string, session?: string, status = "idle"): Owner => ({
  protocol: 1,
  id,
  name: id,
  started: 1,
  last_seen: Math.floor(Date.now() / 1000),
  status,
  ...(session ? { session_id: session } : {}),
  origin: { host: "opencode" },
})

describe("/peer rows", () => {
  test("each peer is one row with the id, harness and title", () => {
    const peer = { ...owner("oc-a"), cwd: "/work/project" }
    const [row] = peerOptions([peer])
    expect(row.title).toBe("oc-a  · opencode  -")
    expect(row.category).toBe("/work/project")
    expect(row.value).toBe("oc-a")
  })

  test("pads short ids so the icon and harness align", () => {
    const rows = peerOptions([owner("oc-a"), owner("oc-long-id")])
    const first = rows[0].title.split("\n")[0]
    const second = rows[1].title.split("\n")[0]
    expect(first.indexOf("·")).toBe(second.indexOf("·"))
  })

  test("marks status and the asking session", () => {
    const mine = owner(peerIdFor("ses_me"), "ses_me", "working")
    const rows = peerOptions([mine], mine.id)
    expect(rows[0].title).toContain("● opencode  - (you)")
  })
})

describe("sending from /peer", () => {
  test("writes an observation to the selected peer's inbox", async () => {
    const spool = new Spool(tempRoot())
    await spool.prepare()
    const id = await queuePeerMessage(
      spool,
      owner("oc-target", "ses_target"),
      "check this",
      { id: "oc-from", name: "opencode-from" },
      "ses_target",
    )
    const [path] = await spool.listJson(spool.inboxPath("oc-target"))
    const message = parseMessage(await spool.read(path), "oc-target")
    expect(message?.id).toBe(id)
    expect(message?.body).toBe("check this")
    expect(message?.session).toBe("ses_target")
    expect(message?.kind).toBe("observation")
  })
})
