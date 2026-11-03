import "./offline.ts"
import { afterAll, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { createAi, createMockDialect } from "@amira/ai"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { ATTACH_INTENTS, ATTACH_ROLES, type RemoteHello } from "../../src/remote/protocol.ts"
import { attachWorkspace } from "../../src/server/attach.ts"
import { ensureWorkspaceDaemon } from "../../src/server/daemon.ts"
import { createWorkspaceRuntime, type WorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"
import { discoveryFixture, FakeDaemonPlatform, release } from "./daemon-fixture.ts"

const roots: string[] = []
const platforms: FakeDaemonPlatform[] = []
afterAll(async () => {
  for (const platform of platforms) await platform.daemon?.stop()
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function fixture() {
  const f = discoveryFixture()
  roots.push(f.root)
  let runtime: WorkspaceRuntime
  const platform = new FakeDaemonPlatform(f.discovery, async (cwd) => {
    runtime = await createWorkspaceRuntime({
      cwd,
      autoTitle: false,
      model: "mock/m",
      ai: createAi({
        dialects: [createMockDialect([{ text: "unused" }])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      }),
      builtins: async () => [],
    })
    return runtime
  })
  platform.roles = true
  platforms.push(platform)
  const options = { discovery: f.discovery, platform, release, roles: true }
  const attach = (capabilities: string[], extra: Partial<RemoteHello> = {}) => {
    const pipes = loopback(29)
    const relay = attachWorkspace({ ...options, io: pipes.server, discovery: () => f.discovery })
    const client = new RemoteConnection(pipes.client, {
      handshake: { role: "client", hello: { ...hello, workspace: f.cwd, capabilities, ...extra } },
    })
    client.ready.catch(() => {})
    return { client, relay }
  }
  return { ...f, platform, options, attach, runtime: () => runtime! }
}

test("a viewer-intent relay never starts a daemon; the refusal is disconnected", async () => {
  const f = fixture()
  const viewer = f.attach([ATTACH_INTENTS.viewer], { clientId: "viewer" })
  await expect(viewer.client.ready).rejects.toMatchObject({ code: "disconnected" })
  await viewer.relay
  expect(f.platform.spawns).toBe(0)
  expect(f.discovery.read()).toBeUndefined()
  // Every other intent still starts one, as today.
  const auto = f.attach([ATTACH_INTENTS.auto], { clientId: "auto" })
  expect(await auto.client.ready).toMatchObject({ role: "controller" })
  expect(f.platform.spawns).toBe(1)
  const watcher = f.attach([ATTACH_INTENTS.viewer], { clientId: "watcher" })
  expect(await watcher.client.ready).toMatchObject({ role: "viewer" })
  expect(f.platform.spawns).toBe(1)
  auto.client.close()
  watcher.client.close()
  await Promise.all([auto.relay, watcher.relay])
})

test("idle stop proceeds with only viewers attached; a controller still keeps the daemon", async () => {
  const f = fixture()
  await ensureWorkspaceDaemon(f.options)
  const controller = f.attach([ATTACH_ROLES], { clientId: "controller" })
  await controller.client.ready
  const viewer = f.attach([ATTACH_INTENTS.viewer], { clientId: "viewer" })
  await viewer.client.ready
  await f.platform.daemon!.tick()
  f.platform.time += 100_000
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(false)
  controller.client.close()
  await controller.relay
  // Viewer reads are not activity and the viewer socket does not count.
  expect(await viewer.client.request("state.read", {})).toBeTruthy()
  await f.platform.daemon!.tick()
  f.platform.time += 100_000
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(true)
  await viewer.client.closed
  await viewer.relay
})

test("a staged replacement proceeds with only viewers attached", async () => {
  const f = fixture()
  const running = await ensureWorkspaceDaemon(f.options)
  const viewer = f.attach([ATTACH_INTENTS.viewer], { clientId: "viewer" })
  await viewer.client.ready
  expect(
    await ensureWorkspaceDaemon({ ...f.options, release: { ...release, buildId: "build-two" } }),
  ).toEqual(running)
  expect(f.discovery.replacement()).toBe(true)
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(true)
  await viewer.client.closed
  await viewer.relay
})

test("a viewer relay from another build watches without staging a replacement", async () => {
  const f = fixture()
  await ensureWorkspaceDaemon(f.options)
  const pipes = loopback(29)
  const relay = attachWorkspace({
    ...f.options,
    release: { ...release, buildId: "build-two" },
    io: pipes.server,
    discovery: () => f.discovery,
  })
  const viewer = new RemoteConnection(pipes.client, {
    handshake: {
      role: "client",
      hello: { ...hello, workspace: f.cwd, capabilities: [ATTACH_INTENTS.viewer], clientId: "viewer" },
    },
  })
  expect(await viewer.ready).toMatchObject({ role: "viewer" })
  expect(f.discovery.replacement()).toBe(false)
  viewer.close()
  await relay
})
