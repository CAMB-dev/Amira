import "./offline.ts"
import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { ensureWorkspaceDaemon } from "../../src/server/daemon.ts"
import { DaemonDiscovery } from "../../src/server/discovery.ts"
import { type DaemonLayout, posixDaemonLayout } from "../../src/server/layout.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { discoveryFixture, FakeDaemonPlatform, release } from "./daemon-fixture.ts"

const roots: string[] = []
const platforms: FakeDaemonPlatform[] = []
afterAll(async () => {
  for (const platform of platforms) await platform.daemon?.stop().catch(() => {})
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})
const runtime = (cwd: string) =>
  createWorkspaceRuntime({
    cwd,
    autoTitle: false,
    model: "mock/m",
    ai: createAi({
      dialects: [createMockDialect()],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [],
  })
function fixture(idleTimeoutMs?: number) {
  const f = discoveryFixture()
  roots.push(f.root)
  const platform = new FakeDaemonPlatform(f.discovery, runtime, idleTimeoutMs)
  platforms.push(platform)
  const lock = path.join(f.discovery.ownershipDirectory, "owner.lock")
  return {
    ...f,
    locations: f.options,
    platform,
    lock,
    options: { discovery: f.discovery, platform, release },
  }
}

test("stop withdraws daemon metadata before the endpoint closes", async () => {
  const f = fixture()
  const listen = f.platform.listen.bind(f.platform)
  let metadataAtClose: boolean | undefined
  f.platform.listen = async (socket, accept) => {
    const listener = await listen(socket, accept)
    return {
      close: async () => {
        metadataAtClose = existsSync(f.discovery.metadataFile)
        await listener.close()
      },
    }
  }
  await ensureWorkspaceDaemon(f.options)
  expect(existsSync(f.discovery.metadataFile)).toBe(true)
  await f.platform.daemon!.stop()
  expect(metadataAtClose).toBe(false)
  expect(existsSync(f.lock)).toBe(false)
})

test.each(["replaced", "deleted"] as const)(
  "a daemon whose owner lock was %s retires at its next tick without touching the files",
  async (change) => {
    const f = fixture()
    const meta = await ensureWorkspaceDaemon(f.options)
    const daemon = f.platform.daemon!
    const original = readFileSync(f.lock, "utf8")
    rmSync(f.lock)
    const replacement = original.replaceAll(original.split("\n")[1]!, "00000000-0000-4000-8000-000000000000")
    if (change === "replaced") writeFileSync(f.lock, replacement, { mode: 0o600 })
    await daemon.tick()
    await daemon.closed
    expect(f.platform.accept).toBeUndefined()
    expect(existsSync(f.lock)).toBe(change === "replaced")
    if (change === "replaced") expect(readFileSync(f.lock, "utf8")).toBe(replacement)
    expect(JSON.parse(readFileSync(f.discovery.metadataFile, "utf8")).nonce).toBe(meta.nonce)
  },
)

test("a long-lived daemon refreshes its directory, lock and metadata times every hour", async () => {
  const f = fixture(3 * 60 * 60 * 1000)
  await ensureWorkspaceDaemon(f.options)
  const daemon = f.platform.daemon!
  const files = [f.discovery.ownershipDirectory, f.lock, f.discovery.metadataFile]
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
  for (const file of files) utimesSync(file, old, old)
  const aged = () => files.map((file) => statSync(file).mtimeMs < Date.now() - 60 * 60 * 1000)
  await daemon.tick()
  expect(aged()).toEqual([true, true, true])
  f.platform.time += 60 * 60 * 1000
  await daemon.tick()
  expect(aged()).toEqual([false, false, false])
  // Refreshing the lock's times never changes its identity or the daemon's authority.
  expect(f.discovery.read()).toBeDefined()
  await daemon.stop()
})

test("a lease policy lets a reused daemon PID fall through to recovery instead of failing", async () => {
  const f = fixture()
  const starts = new Map([[process.pid, "start-1"]])
  const layout: DaemonLayout = {
    ...posixDaemonLayout(f.locations),
    leasePolicy: {
      domain: {
        platform: process.platform,
        host: "machine",
        legacyHost: null,
        boot: null,
        pidNamespace: null,
      },
      start: (pid) => starts.get(pid),
    },
  }
  const discovery = new DaemonDiscovery(f.cwd, layout)
  const first = new FakeDaemonPlatform(discovery, runtime)
  platforms.push(first)
  const original = await ensureWorkspaceDaemon({ discovery, platform: first, release })
  // The recorded PID now names another process: its platform identity and lease start moved on.
  starts.set(process.pid, "start-2")
  const relaunch = new DaemonDiscovery(f.cwd, layout)
  const second = new FakeDaemonPlatform(relaunch, runtime)
  second.identity = "boot:reused"
  platforms.push(second)
  const recovered = await ensureWorkspaceDaemon({ discovery: relaunch, platform: second, release })
  expect(second.spawns).toBe(1)
  expect(recovered.processIdentity).toBe("boot:reused")
  expect(recovered.lockIdentity).not.toBe(original.lockIdentity)
  // The superseded daemon notices the replaced lock and leaves the new owner's files alone.
  await first.daemon!.tick()
  await first.daemon!.closed
  expect(relaunch.read()).toEqual(recovered)
  await second.daemon!.stop()
  expect(relaunch.read()).toBeUndefined()
})
