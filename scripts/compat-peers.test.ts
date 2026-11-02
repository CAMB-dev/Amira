import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loopback } from "../packages/cli/test/remote/loopback.ts"

// Real peers of an earlier release, not an emulation. CI checks out a pre-roles release in a git
// worktree, installs it and sets COMPAT_PEER_TREE to it; without the variable this file is
// skipped. Each side's daemon authority, runtime and client are loaded from its own tree and
// meet only over bytes, in both directions.
const tree = process.env.COMPAT_PEER_TREE
const compat = tree ? test : test.skip
const root = path.resolve(import.meta.dir, "..")

type Side = Awaited<ReturnType<typeof load>>
async function load(base: string) {
  const from = (file: string) => import(pathToFileURL(path.join(base, file)).href)
  const [ai, runtime, attachments, connection, protocol] = await Promise.all([
    from("packages/ai/src/index.ts"),
    from("packages/cli/src/server/runtime.ts"),
    from("packages/cli/src/server/attachments.ts"),
    from("packages/cli/src/remote/connection.ts"),
    from("packages/cli/src/remote/protocol.ts"),
  ])
  return {
    RemoteConnection: connection.RemoteConnection,
    limits: protocol.REMOTE_PEER_LIMITS,
    async daemon(cwd: string, roles?: boolean) {
      const workspace = await runtime.createWorkspaceRuntime({
        cwd,
        model: "mock/test",
        autoTitle: false,
        ai: ai.createAi({
          dialects: [ai.createMockDialect([{ text: "compat reply" }])],
          providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
          fetch: Object.assign(
            () => {
              throw new Error("No network in compatibility tests")
            },
            { preconnect() {} },
          ),
        }),
        builtins: async () => [],
      })
      const authority = attachments.workspaceAttachments(workspace, {
        graceMs: 0,
        heartbeatMs: 0,
        ...(roles === undefined ? {} : { roles }),
      })
      return { runtime: workspace, authority }
    },
  }
}

let previous: Side
let current: Side
let cwd: string
const stops: (() => Promise<void>)[] = []
beforeAll(async () => {
  if (!tree) return
  previous = await load(path.resolve(tree))
  current = await load(root)
  cwd = mkdtempSync(path.join(os.tmpdir(), "amira-compat-"))
})
afterAll(async () => {
  for (const stop of stops.splice(0)) await stop()
  if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

const release = { version: "compat", buildId: "compat-peer", target: "linux-x64" }
function attach(
  client: Side,
  daemon: { authority: { connect(io: unknown, options: unknown): { closed: Promise<void> } } },
  hello: { clientId: string; capabilities: string[] },
  workspace: string,
) {
  const pipes = loopback(41)
  const server = daemon.authority.connect(pipes.server, { workspace, release })
  const frames: { kind: string }[] = []
  const connection = new client.RemoteConnection(pipes.client, {
    handshake: {
      role: "client",
      hello: { v: 1, kind: "hello", workspace, release, limits: client.limits, ...hello },
    },
    onMessage: (message: { kind: string }) => frames.push(message),
  })
  connection.ready.catch(() => {})
  stops.push(async () => {
    connection.close()
    await Promise.all([connection.closed, server.closed])
  })
  return { connection, server, frames }
}

compat("a current viewer intent against a pre-roles daemon lands as a read-only controller", async () => {
  const workspace = path.join(cwd, "previous")
  mkdirSync(workspace)
  const daemon = await previous.daemon(workspace)
  stops.push(() => daemon.runtime.stop())
  const viewer = attach(
    current,
    daemon,
    { clientId: "viewer", capabilities: ["attach.role.viewer"] },
    workspace,
  )
  const welcome = await viewer.connection.ready
  // The string is ignored: no roles, no role field, an ordinary controller lease.
  expect(welcome.capabilities).not.toContain("attach.roles")
  expect(Object.hasOwn(welcome, "role")).toBe(false)
  expect(welcome.controllerGeneration).toBeGreaterThan(0)
  // A take is ignored too: the workspace stays with its holder.
  const taker = attach(current, daemon, { clientId: "taker", capabilities: ["attach.take"] }, workspace)
  await expect(taker.connection.ready).rejects.toMatchObject({ code: "controller_busy" })
  // The client stays attached and reads.
  expect(await viewer.connection.request("state.read", {})).toBeTruthy()
  expect(viewer.connection.failureReason).toBeUndefined()
})

compat("a pre-roles client against the current daemon is never shown roles or taken over", async () => {
  const workspace = path.join(cwd, "current")
  mkdirSync(workspace)
  // Roles on, as on the Linux daemons that ship them.
  const daemon = await current.daemon(workspace, true)
  stops.push(() => daemon.runtime.stop())
  const watcher = attach(
    current,
    daemon,
    { clientId: "watcher", capabilities: ["attach.role.viewer"] },
    workspace,
  )
  expect(await watcher.connection.ready).toMatchObject({ role: "viewer" })
  const legacy = attach(previous, daemon, { clientId: "legacy", capabilities: [] }, workspace)
  const welcome = await legacy.connection.ready
  expect(welcome.capabilities).not.toContain("attach.roles")
  expect(Object.hasOwn(welcome, "role")).toBe(false)
  for (let round = 0; round < 3; round++) {
    const viewer = attach(
      current,
      daemon,
      { clientId: `viewer-${round}`, capabilities: ["attach.role.viewer"] },
      workspace,
    )
    expect(await viewer.connection.ready).toMatchObject({ role: "viewer" })
    viewer.connection.close()
    await viewer.server.closed
  }
  const taker = attach(current, daemon, { clientId: "taker", capabilities: ["attach.take"] }, workspace)
  await expect(taker.connection.ready).rejects.toMatchObject({ code: "controller_busy" })
  // Still attached: its strict decoder would have closed on any frame or field it does not know.
  expect(await legacy.connection.request("permissions.cycle", {})).toBeTruthy()
  expect(await legacy.connection.request("state.read", {})).toBeTruthy()
  expect(legacy.connection.failureReason).toBeUndefined()
  expect(legacy.frames.some((frame) => frame.kind === "attachment")).toBe(false)
})
