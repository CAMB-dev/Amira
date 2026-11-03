import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { prepareForPeer, remoteGateKey, remoteMessageForPeer } from "../../src/remote/peer-compat.ts"
import {
  ATTACH_INTENTS,
  ATTACH_ROLES,
  CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY,
  REMOTE_OPERATION_ACCESS,
  type RemoteAttachment,
  type RemoteMessage,
} from "../../src/remote/protocol.ts"
import { attachedClient, attachIntent, rolesEnabledOn } from "../../src/server/attach-intent.ts"
import { EventFrameCache } from "../../src/server/frame-cache.ts"
import { welcome } from "./loopback.ts"

const attachment: RemoteAttachment = {
  v: 1,
  kind: "attachment",
  daemonEpoch: "epoch-1",
  controller: { state: "attached", client: { buildId: "amira-gui", target: "win32-x64", version: "0.2.0" } },
  viewers: [{ client: { buildId: "amira-tui", target: "linux-x64" }, attachedMs: 120_000 }],
}

test("attachment frames and welcome.role never reach a peer without attach.roles", () => {
  expect(remoteMessageForPeer(attachment, [])).toBeUndefined()
  expect(prepareForPeer(attachment, ["model.proxy"])).toBeUndefined()
  expect(remoteMessageForPeer(attachment, [ATTACH_ROLES])).toEqual(attachment)
  // Every intent string implies attach.roles.
  for (const intent of Object.values(ATTACH_INTENTS))
    expect(remoteMessageForPeer(attachment, [intent])).toEqual(attachment)
  const roleWelcome = { ...welcome, role: "viewer" as const }
  const legacy = remoteMessageForPeer(roleWelcome, ["model.proxy"])!
  expect(Object.hasOwn(legacy, "role")).toBe(false)
  expect(legacy).toEqual(welcome)
  expect(roleWelcome.role).toBe("viewer")
  expect(remoteMessageForPeer(roleWelcome, [ATTACH_INTENTS.viewer])).toMatchObject({ role: "viewer" })
})

test("displayed client text: a version with control characters is omitted", () => {
  const release = { buildId: "amira-tui", target: "linux-x64" }
  expect(attachedClient({ ...release, version: "1.2.3-nightly+abc" })).toEqual({
    ...release,
    version: "1.2.3-nightly+abc",
  })
  for (const version of ["1.0\u001b[31m", "1.0\u0007", "1.0 beta", "x".repeat(65)])
    expect(attachedClient({ ...release, version })).toEqual(release)
})

test("intent parsing: one intent, take over viewer over auto, and nothing at all where roles are off", () => {
  expect(attachIntent([], true)).toBe("legacy")
  expect(attachIntent(["model.proxy"], true)).toBe("legacy")
  expect(attachIntent([ATTACH_ROLES], true)).toBe("controller")
  expect(attachIntent([ATTACH_INTENTS.auto], true)).toBe("auto")
  expect(attachIntent([ATTACH_INTENTS.auto, ATTACH_INTENTS.viewer], true)).toBe("viewer")
  expect(attachIntent([ATTACH_INTENTS.viewer, ATTACH_INTENTS.take, ATTACH_INTENTS.auto], true)).toBe("take")
  for (const intent of [ATTACH_ROLES, ...Object.values(ATTACH_INTENTS)])
    expect(attachIntent([intent], false)).toBe("legacy")
  // Viewers can read the whole workspace: only platforms whose daemon checks the peer.
  expect(rolesEnabledOn("linux")).toBe(true)
  expect(rolesEnabledOn("win32")).toBe(false)
  expect(rolesEnabledOn("darwin")).toBe(false)
})

test("the frame cache encodes a live event once per gate set and never shares replayed copies", () => {
  const cache = new EventFrameCache()
  const event: RemoteMessage = {
    v: 1,
    kind: "event",
    daemonEpoch: "epoch-1",
    seq: 7,
    payload: { kind: "effect", effect: { kind: "unfocus" } },
  }
  const legacy = cache.prepare(event, [])!
  expect(cache.prepare(event, ["model.proxy"])).toBe(legacy)
  const roles = cache.prepare(event, [ATTACH_INTENTS.viewer])!
  expect(cache.prepare(event, [ATTACH_ROLES, "model.proxy"])).toBe(roles)
  expect(remoteGateKey([ATTACH_ROLES])).not.toBe(remoteGateKey([]))
  expect(remoteGateKey([ATTACH_ROLES, CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY])).toBe("")
  // Identical bytes to an uncached encoding for the same peer.
  expect(Buffer.from(legacy.bytes).toString()).toBe(Buffer.from(prepareForPeer(event, [])!.bytes).toString())
  expect(Buffer.from(roles.bytes)).toEqual(Buffer.from(legacy.bytes))
  const next = { ...event, seq: 8 }
  expect(cache.prepare(next, [])).not.toBe(legacy)
  const replayed = { ...event, replay: true }
  expect(cache.prepare(replayed, [])).not.toBe(cache.prepare(replayed, []))
})

test("the published schema's x-access matches the access table", () => {
  const schema = JSON.parse(
    readFileSync(path.resolve(import.meta.dir, "../../../../docs/protocol/frontend-v1.schema.json"), "utf8"),
  ) as { "x-operations": Record<string, { "x-access": unknown }> }
  const published = Object.fromEntries(
    Object.entries(schema["x-operations"]).map(([op, entry]) => [op, entry["x-access"]]),
  )
  const expected = Object.fromEntries(
    Object.keys(published).map((op) => [
      op,
      REMOTE_OPERATION_ACCESS[op as keyof typeof REMOTE_OPERATION_ACCESS],
    ]),
  )
  expect(Object.keys(published).length).toBeGreaterThan(40)
  expect(published).toEqual(expected)
})
