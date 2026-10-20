import "./offline.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { attachWorkspace, stopWorkspace } from "../../src/server/attach.ts"
import { ensureWorkspaceDaemon } from "../../src/server/daemon.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"
import { discoveryFixture, FakeDaemonPlatform, release } from "./daemon-fixture.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture() {
  const f = discoveryFixture()
  const platform = new FakeDaemonPlatform(f.discovery, (cwd) =>
    createWorkspaceRuntime({
      cwd,
      model: "mock/m",
      autoTitle: false,
      builtins: async () => [],
      ai: createAi({
        dialects: [createMockDialect([{ text: "fixture" }])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      }),
    }),
  )
  cleanup.push(async () => {
    await platform.daemon?.stop()
    rmSync(f.root, { recursive: true, force: true, maxRetries: 3 })
  })
  return { ...f, platform, options: { discovery: f.discovery, platform, release } }
}
function attach(f: ReturnType<typeof fixture>, installed = release) {
  const pipes = loopback(29)
  const relay = attachWorkspace({
    io: pipes.server,
    discovery: () => f.discovery,
    platform: f.platform,
    release: installed,
  })
  const client = new RemoteConnection(pipes.client, {
    handshake: { role: "client", hello: { ...hello, workspace: f.cwd } },
  })
  cleanup.push(async () => {
    client.close()
    await relay
  })
  return { client, relay }
}

test("relay preserves typed incompatibility with fixed explicit-stop/retry guidance and no restart", async () => {
  const f = fixture()
  const meta = await ensureWorkspaceDaemon(f.options)
  f.discovery.publish({ ...meta, protocol: 2 })
  const { client } = attach(f)
  await expect(client.ready).rejects.toMatchObject({
    code: "incompatible_protocol",
    message:
      "The running daemon is incompatible. Explicitly stop it, then retry attaching. Active work will not be restarted automatically.",
  })
  expect(f.platform.spawns).toBe(1)
  f.discovery.publish(meta)
})

test("relay sanitizes arbitrary exceptions even when their code impersonates incompatibility", async () => {
  const f = fixture()
  f.discovery.read = () => {
    throw Object.assign(new Error("SENTINEL_SECRET /private/workspace"), { code: "incompatible_protocol" })
  }
  const { client } = attach(f)
  await expect(client.ready).rejects.toMatchObject({
    code: "startup_failed",
    message: "The remote workspace could not attach",
  })
  expect(f.platform.spawns).toBe(0)
})

test("compatible retirement cannot fall between readiness and attachment admission", async () => {
  const f = fixture()
  await ensureWorkspaceDaemon(f.options)
  let connections = 0
  const connect = f.platform.connect.bind(f.platform)
  f.platform.connect = async (...args: Parameters<typeof f.platform.connect>) => {
    if (++connections === 2) {
      await Bun.sleep(0)
      await f.platform.daemon!.tick()
    }
    return connect(...args)
  }
  const { client } = attach(f, { ...release, buildId: "installed-new-build" })
  await expect(client.ready).resolves.toMatchObject({ release })
  expect(connections).toBe(1)
  expect(f.platform.spawns).toBe(1)
})

test("verified retirement before endpoint acquisition retries discovery within the startup deadline", async () => {
  const f = fixture()
  const old = await ensureWorkspaceDaemon(f.options)
  f.discovery.replacement({ ...release, buildId: "installed-new-build" })
  let retire = true
  const identity = f.platform.processIdentity
  f.platform.processIdentity = () => {
    if (retire) {
      retire = false
      rmSync(f.discovery.socket)
      void f.platform.daemon!.stop()
    }
    return identity()
  }
  const { client } = attach(f)
  const welcome = await client.ready
  expect(welcome.daemonEpoch).not.toBe(old.daemonEpoch)
  expect(f.platform.spawns).toBe(2)
})

test("missing metadata cannot launch another daemon while a live owner is still initializing or retiring", async () => {
  const f = fixture()
  const owner = f.discovery.claim("owner")!
  try {
    await expect(ensureWorkspaceDaemon({ ...f.options, startupTimeoutMs: 100 })).rejects.toThrow(
      "startup deadline",
    )
    expect(f.platform.spawns).toBe(0)
  } finally {
    owner.release()
  }
})

test("a metadata-selected socket symlink is rejected before connecting or sending its nonce", async () => {
  const f = fixture()
  await ensureWorkspaceDaemon(f.options)
  const target = path.join(f.cwd, "not-a-socket")
  mkdirSync(target)
  rmSync(f.discovery.socket)
  symlinkSync(target, f.discovery.socket, process.platform === "win32" ? "junction" : "dir")
  let connections = 0
  const connect = f.platform.connect.bind(f.platform)
  f.platform.connect = async (...args: Parameters<typeof f.platform.connect>) => {
    connections++
    return connect(...args)
  }
  try {
    await expect(ensureWorkspaceDaemon({ ...f.options, startupTimeoutMs: 100 })).rejects.toThrow()
    expect(connections).toBe(0)
    await expect(stopWorkspace(f.discovery, f.platform)).rejects.toThrow()
    expect(connections).toBe(0)
  } finally {
    rmSync(f.discovery.socket)
    writeFileSync(f.discovery.socket, "fake-private-socket")
  }
})

test("a socket replaced during connection is closed before admission or nonce delivery", async () => {
  const f = fixture()
  const meta = await ensureWorkspaceDaemon(f.options)
  const endpoint = f.discovery.endpoint(meta)
  const replacement = path.join(f.discovery.directory, "replacement.sock")
  writeFileSync(replacement, "fake-private-socket")
  let admissions = 0
  const accept = f.platform.accept!
  f.platform.accept = (io) => {
    admissions++
    accept(io)
  }
  f.platform.beforeConnect = () => {
    rmSync(meta.socket)
    renameSync(replacement, meta.socket)
  }
  await expect(f.platform.connect(endpoint)).rejects.toThrow("identity changed")
  expect(admissions).toBe(0)
})
