import "./offline.ts"
import { afterAll, expect, spyOn, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { createAi, createMockDialect } from "@amira/ai"
import type { BackgroundJobInfo, UiApi } from "@amira/api"
import { backgroundJobs } from "@amira/proc"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { attachWorkspace, stopWorkspace } from "../../src/server/attach.ts"
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
  let ui: UiApi
  const dialect = createMockDialect([{ text: "work retained", delayMs: 60 }])
  const platform = new FakeDaemonPlatform(f.discovery, async (cwd) => {
    runtime = await createWorkspaceRuntime({
      cwd,
      autoTitle: false,
      model: "mock/m",
      ai: createAi({ dialects: [dialect], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] }),
      builtins: async () => [
        {
          source: "fixture",
          extension: (api) => {
            ui = api.ui
          },
        },
      ],
    })
    return runtime
  })
  platforms.push(platform)
  return {
    ...f,
    platform,
    options: { discovery: f.discovery, platform, release },
    runtime: () => runtime!,
    ui: () => ui!,
  }
}
async function eventually(check: () => boolean) {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test("racing discovery starts publish one ready runtime; explicit stop releases ownership and restart gets a new epoch", async () => {
  const f = fixture()
  const [first, second] = await Promise.all([
    ensureWorkspaceDaemon(f.options),
    ensureWorkspaceDaemon(f.options),
  ])
  expect(first).toEqual(second)
  expect(f.platform.spawns).toBe(1)
  expect(f.discovery.read()).toEqual(first)
  await stopWorkspace(f.discovery, f.platform)
  await f.platform.daemon!.closed
  expect(existsSync(f.discovery.socket)).toBe(false)
  expect(f.discovery.read()).toBeUndefined()
  const restarted = await ensureWorkspaceDaemon(f.options)
  expect(restarted.daemonEpoch).not.toBe(first.daemonEpoch)
  expect(restarted.nonce).not.toBe(first.nonce)
})

test("failed startup/bind releases ownership and never publishes readiness", async () => {
  const f = fixture()
  f.platform.startupError = true
  await expect(ensureWorkspaceDaemon(f.options)).rejects.toThrow("startup failed")
  f.platform.startupError = false
  f.platform.listenError = true
  await expect(ensureWorkspaceDaemon(f.options)).rejects.toThrow("bind failed")
  expect(f.discovery.read()).toBeUndefined()
  const owner = f.discovery.claim("owner")!
  expect(owner).toBeDefined()
  owner.release()
  f.platform.listenError = false
  await ensureWorkspaceDaemon(f.options)
})

test("PID replacement and inaccessible live sockets never authorize a new owner or kill", async () => {
  const f = fixture()
  await ensureWorkspaceDaemon(f.options)
  f.platform.identity = "boot:reused"
  await expect(ensureWorkspaceDaemon(f.options)).rejects.toThrow("PID identity changed")
  f.platform.identity = "boot:123"
  const accept = f.platform.accept
  f.platform.accept = undefined
  await expect(ensureWorkspaceDaemon({ ...f.options, startupTimeoutMs: 100 })).rejects.toThrow(
    "startup deadline",
  )
  expect(f.platform.spawns).toBe(1)
  expect(f.runtime().signal.aborted).toBe(false)
  f.platform.accept = accept
})

test("relay EOF preserves the runtime/turn; replay reconnect uses the same epoch and lease", async () => {
  const f = fixture()
  const pipes = loopback(23)
  const relay = attachWorkspace({ ...f.options, io: pipes.server, discovery: () => f.discovery })
  const first = new RemoteConnection(pipes.client, {
    handshake: { role: "client", hello: { ...hello, workspace: f.cwd } },
  })
  const welcome = await first.ready
  await first.request("turn.prompt", { message: "retain this turn" })
  first.close()
  await relay
  expect(f.runtime().signal.aborted).toBe(false)
  await eventually(() => f.runtime().quiescent())
  const nextPipes = loopback(31)
  const nextRelay = attachWorkspace({ ...f.options, io: nextPipes.server, discovery: () => f.discovery })
  const second = new RemoteConnection(nextPipes.client, {
    handshake: {
      role: "client",
      hello: {
        ...hello,
        workspace: f.cwd,
        snapshot: true,
        resume: { daemonEpoch: welcome.daemonEpoch, after: 0, controllerToken: welcome.controllerToken! },
      },
    },
  })
  try {
    expect((await second.ready).daemonEpoch).toBe(welcome.daemonEpoch)
    expect(JSON.stringify(f.runtime().workspaceSnapshot())).toContain("work retained")
    expect(f.platform.spawns).toBe(1)
  } finally {
    second.close()
    await nextRelay
  }
})

test("relay EPIPE leaves admitted work and runtime authority alive", async () => {
  const f = fixture()
  const pipes = loopback(37)
  let broken = false
  const relay = attachWorkspace({
    ...f.options,
    discovery: () => f.discovery,
    io: {
      ...pipes.server,
      async write(bytes) {
        if (broken) throw Object.assign(new Error("fixture broken output"), { code: "EPIPE" })
        await pipes.server.write(bytes)
      },
    },
  })
  const client = new RemoteConnection(pipes.client, {
    handshake: { role: "client", hello: { ...hello, workspace: f.cwd } },
  })
  try {
    await client.ready
    await client.request("turn.prompt", { message: "finish after EPIPE" })
    broken = true
    await relay
    expect(f.runtime().signal.aborted).toBe(false)
    await eventually(() => f.runtime().quiescent())
    expect(JSON.stringify(f.runtime().workspaceSnapshot())).toContain("work retained")
  } finally {
    client.close()
  }
})

test("idle shutdown is blocked by controllers, approvals and jobs, then uses a full quiet interval", async () => {
  const f = fixture()
  await ensureWorkspaceDaemon(f.options)
  const attachment = f.runtime().attach()
  f.platform.time = 100_000
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(false)
  await attachment.detach()
  const question = f.ui().confirm("Keep approval pending?")
  f.platform.time += 100_000
  await f.platform.daemon!.tick()
  expect(f.runtime().quiescent()).toBe(false)
  const answer = f.runtime().attach()
  await answer.request("ui.respond", { requestId: answer.pendingRequests[0]!.requestId, value: true })
  await question
  await answer.detach()
  const job: BackgroundJobInfo = {
    id: "fixture-job",
    command: "never-spawned",
    cwd: f.cwd,
    status: "running",
    startedAt: 1,
    contained: true,
    owner: "fixture",
    stopRequested: false,
    meta: {},
    exitCode: null,
    signal: null,
    outputChars: 0,
  }
  const jobs = spyOn(backgroundJobs, "list").mockReturnValue([job])
  try {
    f.platform.time += 100_000
    expect(f.runtime().quiescent()).toBe(false)
    await f.platform.daemon!.tick()
    expect(f.runtime().signal.aborted).toBe(false)
  } finally {
    jobs.mockRestore()
  }
  await eventually(() => f.runtime().quiescent())
  await f.platform.daemon!.tick()
  f.platform.time += 999
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(false)
  f.platform.time++
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(true)
})

test("compatible build mismatch stages drain at quiescence, incompatible wire fails without destructive restart", async () => {
  const f = fixture()
  const running = await ensureWorkspaceDaemon(f.options)
  const active = f.runtime().attach()
  const installed = { ...release, buildId: "build-two" }
  expect(await ensureWorkspaceDaemon({ ...f.options, release: installed })).toEqual(running)
  expect(f.discovery.replacement()).toBe(true)
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(false)
  f.discovery.publish({ ...running, protocol: 2 })
  await expect(ensureWorkspaceDaemon(f.options)).rejects.toThrow("incompatible")
  expect(f.platform.spawns).toBe(1)
  f.discovery.publish(running)
  await active.detach()
  await f.platform.daemon!.tick()
  expect(f.runtime().signal.aborted).toBe(true)
})
