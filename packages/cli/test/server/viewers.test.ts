import { expect, test } from "bun:test"
import {
  REMOTE_OPERATION_ACCESS,
  REMOTE_OPERATIONS,
  type RemoteOperation,
} from "../../src/remote/protocol.ts"
import { operationFixtures } from "../remote/schema-fixtures.ts"
import { caps, closedWith, eventually, viewerFixture } from "./viewer-fixture.ts"

// Before attachment roles the server sent only these frames and welcome fields. A client that
// sends no role string must never see anything else, whatever viewers and takers do.
const legacyKinds = new Set(["reset", "event", "model.event", "cancel", "ping", "pong", "chunk"])
const legacyWelcome = [
  "capabilities",
  "controllerGeneration",
  "controllerToken",
  "daemonEpoch",
  "kind",
  "limits",
  "release",
  "sessionGeneration",
  "v",
  "workspace",
  "workspaceId",
]
const modelOps = new Set<RemoteOperation>(["model.open", "model.stream", "model.compact"])

test("a viewer runs every viewer operation and gets not_controller for every other one", async () => {
  const f = await viewerFixture()
  const controller = f.connect(caps.roles, { clientId: "controller" })
  expect(await controller.client.ready).toMatchObject({ role: "controller", controllerGeneration: 1 })
  const viewer = f.connect(caps.viewer, { clientId: "viewer" })
  const welcome = await viewer.client.ready
  expect(welcome).toMatchObject({ role: "viewer", controllerGeneration: 0 })
  expect(welcome.capabilities).toContain("attach.roles")
  expect(welcome.controllerToken).not.toBe((await controller.client.ready).controllerToken)
  for (const op of REMOTE_OPERATIONS) {
    if (modelOps.has(op)) continue
    const params = (operationFixtures as Record<string, { params: unknown }>)[op]!.params
    const outcome = await viewer.client.request(op, params as never).then(
      () => "ok",
      (error: { code?: string }) => error.code,
    )
    if (REMOTE_OPERATION_ACCESS[op].viewer) expect([op, outcome]).not.toEqual([op, "not_controller"])
    else expect([op, outcome]).toEqual([op, "not_controller"])
  }
  // Plain reads succeed with schema-valid results (the server validates every result it sends).
  for (const op of ["state.read", "transcript.read", "status.read", "models.list", "sessions.list"] as const)
    expect(await viewer.client.request(op, {})).toBeTruthy()
  // Generation 0 is the viewer's only valid generation.
  await expect(viewer.client.request("state.read", {}, { controllerGeneration: 1 })).rejects.toMatchObject({
    code: "stale_controller",
  })
  // Model frames from a viewer are ignored, not fatal; ack and pong are accepted.
  await viewer.client.send({
    v: 1,
    kind: "model.frame",
    daemonEpoch: welcome.daemonEpoch,
    controllerGeneration: 0,
    sessionGeneration: welcome.sessionGeneration,
    callId: "call-1",
    seq: 1,
    payload: { kind: "stream", data: { value: { type: "text.delta", text: "hi" }, usage: [] } },
  })
  await viewer.client.send({ v: 1, kind: "pong", id: "heartbeat" })
  expect(await viewer.client.request("state.read", {})).toBeTruthy()
  // The controller was never disturbed.
  expect(await controller.client.request("permissions.cycle", {})).toBeTruthy()
})

test("a client without role strings is never shown roles and never taken over while attached", async () => {
  const f = await viewerFixture()
  const legacy = f.connect(caps.legacy, { clientId: "legacy" })
  const welcome = await legacy.client.ready
  expect(Object.keys(welcome).sort()).toEqual(legacyWelcome)
  expect(welcome.capabilities).not.toContain("attach.roles")
  for (let round = 0; round < 3; round++) {
    const viewer = f.connect(caps.viewer, { clientId: `viewer-${round}` })
    expect(await viewer.client.ready).toMatchObject({ role: "viewer" })
    viewer.client.close()
    await viewer.server.closed
  }
  f.advance(5_000)
  const taker = f.connect(caps.take, { clientId: "taker" })
  await expect(taker.client.ready).rejects.toMatchObject({ code: "controller_busy" })
  const auto = f.connect(caps.auto, { clientId: "auto" })
  expect(await auto.client.ready).toMatchObject({ role: "viewer" })
  expect(await legacy.client.request("permissions.cycle", {})).toBeTruthy()
  expect(await legacy.client.request("state.read", {})).toBeTruthy()
  expect(legacy.client.failureReason).toBeUndefined()
  expect(legacy.frames.filter((frame) => !legacyKinds.has(frame.kind))).toEqual([])
})

test("hello outcomes: busy keeps the holder, auto never reinterprets a refused resume, a viewer hello hands back", async () => {
  const f = await viewerFixture({ graceMs: 30_000 })
  const holder = f.connect(caps.roles, { clientId: "holder" })
  const lease = await holder.client.ready
  // A second connection of the same clientId without the token is refused and closes nothing.
  const duplicate = f.connect(caps.roles, { clientId: "holder" })
  await expect(duplicate.client.ready).rejects.toMatchObject({ code: "controller_busy" })
  const auto = f.connect(caps.auto, { clientId: "auto" })
  expect(await auto.client.ready).toMatchObject({ role: "viewer" })
  expect(holder.client.failureReason).toBeUndefined()
  await eventually(() => holder.presence()?.viewers.length === 1)
  expect(holder.presence()).toMatchObject({
    controller: { state: "attached", client: { buildId: "fixture", target: "test-native", version: "test" } },
    viewers: [{ client: { buildId: "fixture" }, attachedMs: expect.any(Number) }],
  })
  // The holder hands control back by reconnecting as a viewer with its own token: no grace.
  const resume = { daemonEpoch: lease.daemonEpoch, after: 0, controllerToken: lease.controllerToken! }
  const handBack = f.connect(caps.viewer, { clientId: "holder", resume })
  expect(await handBack.client.ready).toMatchObject({ role: "viewer" })
  await holder.client.closed
  await eventually(
    () => auto.presence()?.controller.state === "none" && auto.presence()?.viewers.length === 2,
  )
  // A refused resume (stale token) under auto is a viewer even though the workspace is free.
  const stale = f.connect(caps.auto, { clientId: "stale", resume: { ...resume, controllerToken: "stale" } })
  expect(await stale.client.ready).toMatchObject({ role: "viewer" })
  // Without a token, auto takes the free workspace.
  const fresh = f.connect(caps.auto, { clientId: "fresh" })
  expect(await fresh.client.ready).toMatchObject({ role: "controller" })
  await eventually(() => auto.presence()?.controller.state === "attached")
  // One live connection per clientId: an admitted hello replaces the older connection.
  const again = f.connect(caps.viewer, { clientId: "auto" })
  expect(await again.client.ready).toMatchObject({ role: "viewer" })
  expect(await closedWith(auto.client)).toBe("disconnected")
})

test("take: free, against a roles holder, the one-second rule, and an own lease in grace", async () => {
  const f = await viewerFixture({ graceMs: 30_000 })
  const first = f.connect(caps.take, { clientId: "first" })
  expect(await first.client.ready).toMatchObject({ role: "controller", controllerGeneration: 1 })
  // Within a second of the last change another taker loses.
  const early = f.connect(caps.take, { clientId: "second" })
  await expect(early.client.ready).rejects.toMatchObject({ code: "controller_busy" })
  f.advance(1_000)
  const second = f.connect(caps.take, { clientId: "second" })
  expect(await second.client.ready).toMatchObject({ role: "controller", controllerGeneration: 2 })
  expect(await closedWith(first.client)).toBe("controller_taken")
  // The old holder comes back as a viewer and sees the new controller.
  const back = f.connect(caps.viewer, { clientId: "first" })
  expect(await back.client.ready).toMatchObject({ role: "viewer" })
  await eventually(() => back.presence()?.controller.state === "attached")
  // The holder drops into grace; its own take reissues the lease at once.
  second.client.close()
  await second.server.closed
  await eventually(() => back.presence()?.controller.state === "detached")
  expect(back.presence()?.controller.graceRemainingMs).toBeGreaterThan(0)
  const retake = f.connect(caps.take, { clientId: "second" })
  expect(await retake.client.ready).toMatchObject({ role: "controller", controllerGeneration: 3 })
  // Another client may take a lease in grace too; grace ends.
  retake.client.close()
  await retake.server.closed
  f.advance(1_000)
  const third = f.connect(caps.take, { clientId: "third" })
  expect(await third.client.ready).toMatchObject({ role: "controller", controllerGeneration: 4 })
  await eventually(() => back.presence()?.controller.state === "attached")
})

test("the ninth viewer is refused; a reconnecting viewer reuses its own slot", async () => {
  const f = await viewerFixture()
  const viewers = []
  for (let index = 0; index < 8; index++) {
    const viewer = f.connect(caps.viewer, { clientId: `viewer-${index}` })
    await viewer.client.ready
    viewers.push(viewer)
  }
  expect(f.authority.viewers).toBe(8)
  const ninth = f.connect(caps.viewer, { clientId: "viewer-8" })
  await expect(ninth.client.ready).rejects.toMatchObject({ code: "limit_exceeded" })
  const same = f.connect(caps.viewer, { clientId: "viewer-0" })
  expect(await same.client.ready).toMatchObject({ role: "viewer" })
  await viewers[0]!.client.closed
  await eventually(() => f.authority.viewers === 8)
  // A controller is not a viewer and is never counted against the cap.
  const controller = f.connect(caps.roles, { clientId: "controller" })
  expect(await controller.client.ready).toMatchObject({ role: "controller" })
  await eventually(() => controller.presence()?.viewers.length === 8)
})
