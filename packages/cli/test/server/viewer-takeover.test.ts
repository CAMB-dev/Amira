import { expect, test } from "bun:test"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import { caps, closedWith, eventually, fakeModelProxy, viewerFixture } from "./viewer-fixture.ts"

const snapshotOf = (runtime: { workspaceSnapshot(): unknown }) =>
  runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot

test("takeover keeps the running turn and pending UI request; the old holder reads the outcome as a viewer", async () => {
  const f = await viewerFixture({
    graceMs: 30_000,
    replies: [{ text: "survives the takeover", delayMs: 150 }],
  })
  const old = f.connect(caps.roles, { clientId: "old" })
  await old.client.ready
  const question = f.api().ui.confirm("Answer after the takeover?")
  await eventually(() => snapshotOf(f.runtime).pendingRequests.length === 1)
  await old.client.request("turn.prompt", { message: "run while control moves" })
  const finished = () => JSON.stringify(f.runtime.workspaceSnapshot()).includes("survives the takeover")
  expect(finished()).toBe(false)
  f.advance(1_000)
  const taker = f.connect(caps.take, { clientId: "new" })
  expect(await taker.client.ready).toMatchObject({ role: "controller" })
  expect(await closedWith(old.client)).toBe("controller_taken")
  // The new controller answers the request the old holder never did.
  const pending = snapshotOf(f.runtime).pendingRequests[0]!
  expect(await taker.client.request("ui.respond", { requestId: pending.requestId, value: true })).toBeTruthy()
  expect(await question).toBe(true)
  // The turn is not revoked by the transport change.
  await eventually(finished)
  const cursor = Math.max(...old.events())
  const viewer = f.connect(caps.viewer, {
    clientId: "old",
    resume: { daemonEpoch: (await taker.client.ready).daemonEpoch, after: cursor, controllerToken: "stale" },
  })
  expect(await viewer.client.ready).toMatchObject({ role: "viewer" })
  expect(JSON.stringify(await viewer.client.request("transcript.read", {}))).toContain(
    "survives the takeover",
  )
  // It resumed from its cursor: no snapshot, just the events it missed.
  await eventually(() => viewer.events().length > 0)
  expect(viewer.frames.some((frame) => frame.kind === "reset")).toBe(false)
  expect(Math.min(...viewer.events())).toBe(cursor + 1)
})

test("only controllers are model peers; a non-serving taker cannot strand a serving holder", async () => {
  const model = fakeModelProxy()
  const f = await viewerFixture({ modelProxy: model.proxy })
  const holder = f.connect([...caps.roles, "model.proxy"], { clientId: "holder" })
  await holder.client.ready
  await eventually(() => model.attached.length === 1)
  expect(model.attached[0]).toBe(holder.server)
  const viewer = f.connect([...caps.viewer, "model.proxy"], { clientId: "viewer" })
  const welcome = await viewer.client.ready
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
  expect(await viewer.client.request("state.read", {})).toBeTruthy()
  expect(model.attached).toEqual([holder.server])
  expect(model.received).toEqual([])
  f.advance(1_000)
  const plain = f.connect(caps.take, { clientId: "plain" })
  await expect(plain.client.ready).rejects.toMatchObject({ code: "unsupported_capability" })
  expect(holder.client.failureReason).toBeUndefined()
  const serving = f.connect([...caps.take, "model.proxy"], { clientId: "serving" })
  await serving.client.ready
  expect(await closedWith(holder.client)).toBe("controller_taken")
  await eventually(() => model.attached.length === 2)
  expect(model.attached[1]).toBe(serving.server)
})

test("every connection gets the same seq stream; a stalled viewer is closed alone", async () => {
  const f = await viewerFixture()
  const controller = f.connect(caps.roles, { clientId: "controller" })
  await controller.client.ready
  const viewers = []
  // Viewers load one after another: at most two initial snapshots may be pending at once.
  for (let index = 0; index < 3; index++) {
    const viewer = f.connect(caps.viewer, { clientId: `viewer-${index}` })
    await viewer.client.ready
    await eventually(() => viewer.events().length > 0)
    viewers.push(viewer)
  }
  // Welcome goes out, then nothing more is written: its snapshot and every event pile up.
  const stalled = f.connect(caps.viewer, { clientId: "stalled", stallAfterWrites: 1 })
  await stalled.client.ready
  const healthy = [controller, ...viewers]
  const base = Math.max(...healthy.map((peer) => Math.max(...peer.events())))
  const after = (peer: (typeof healthy)[number]) => peer.events().filter((seq) => seq > base)
  for (let batch = 1; batch <= 11; batch++) {
    for (let index = 0; index < 100; index++)
      f.runtime.journal.append({ kind: "effect", effect: { kind: "unfocus" } })
    await eventually(() => healthy.every((peer) => after(peer).length >= batch * 100))
  }
  expect(await closedWith(stalled.client)).toBe("disconnected")
  expect(stalled.server.failureReason).toMatchObject({ code: "limit_exceeded" })
  const stream = after(controller)
  expect(stream).toEqual(Array.from({ length: stream.length }, (_, index) => base + 1 + index))
  for (const peer of viewers) {
    expect(after(peer)).toEqual(stream)
    expect(peer.client.failureReason).toBeUndefined()
  }
  expect(controller.client.failureReason).toBeUndefined()
})

test("at most two viewer snapshots are pending; a third fresh viewer is told to retry", async () => {
  const f = await viewerFixture()
  const first = f.connect(caps.viewer, { clientId: "slow-1", stallAfterWrites: 1 })
  const second = f.connect(caps.viewer, { clientId: "slow-2", stallAfterWrites: 1 })
  await Promise.all([first.client.ready, second.client.ready])
  const third = f.connect(caps.viewer, { clientId: "third" })
  await expect(third.client.ready).rejects.toMatchObject({ code: "workspace_busy" })
  // Controllers and cursor resumes need no new snapshot and are never held back.
  const controller = f.connect(caps.roles, { clientId: "controller" })
  const welcome = await controller.client.ready
  await eventually(() => controller.events().length > 0)
  const after = Math.max(...controller.events())
  const resumed = f.connect(caps.viewer, {
    clientId: "resumed",
    resume: { daemonEpoch: welcome.daemonEpoch, after, controllerToken: "none" },
  })
  expect(await resumed.client.ready).toMatchObject({ role: "viewer" })
  first.client.close()
  await first.server.closed
  const retry = f.connect(caps.viewer, { clientId: "third" })
  expect(await retry.client.ready).toMatchObject({ role: "viewer" })
  await eventually(() => retry.events().length > 0)
})
