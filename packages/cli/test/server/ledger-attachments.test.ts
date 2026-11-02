import "./offline.ts"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ExtensionAPI } from "@amira/api"
import { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteHello, RemoteJson } from "../../src/remote/protocol.ts"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { OperationLedger } from "../../src/server/operation-ledger.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function eventually(check: () => boolean) {
  const end = Date.now() + 4000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}

async function fixture(ledger: { idleScopeMs?: number; now?: () => number } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-ledger-attach-"))
  let api!: ExtensionAPI
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    ai: createAi({
      dialects: [createMockDialect()],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [
      {
        source: "fixture",
        extension: (value) => {
          api = value
        },
      },
    ],
  })
  const authority = workspaceAttachments(runtime, { graceMs: 0, heartbeatMs: 0, ledger })
  const connections: RemoteConnection[] = []
  const connect = (extra: Partial<RemoteHello> = {}) => {
    const io = loopback(41)
    const server = authority.connect(io.server, { workspace: cwd, release: hello.release })
    const client = new RemoteConnection(io.client, {
      handshake: { role: "client", hello: { ...hello, workspace: cwd, ...extra } },
    })
    connections.push(client, server)
    return { client, server }
  }
  cleanup.push(async () => {
    for (const connection of connections) connection.close()
    await Promise.all(connections.map((connection) => connection.closed))
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  return { runtime, connect, api: () => api }
}

test("form.evaluate never takes a ledger slot, and a repeated revision returns the cached change", async () => {
  const f = await fixture()
  const { client } = f.connect()
  await client.ready
  let changes = 0
  const answer = f.api().ui.form({
    title: "Typing",
    fields: [{ type: "text", id: "name", label: "Name" }],
    change: (values) => ({ values: { name: `${values.name}`.trim() }, message: `change ${++changes}` }),
  })
  await eventually(
    () => (f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).pendingRequests.length === 1,
  )
  const requestId = (f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).pendingRequests[0]!
    .requestId
  const editor = (await client.request("form.open", { requestId })) as { editor: string; revision: number }
  const run = spyOn(OperationLedger.prototype, "run")
  try {
    // More keystrokes than the 128 live ledger entries, each with a fresh request id.
    let evaluation: RemoteJson = null
    for (let index = 0; index < 200; index++)
      evaluation = await client.request("form.evaluate", {
        requestId,
        draft: { ...editor, values: { name: `n${index} ` }, previous: { name: "" } },
      })
    expect(evaluation).toMatchObject({ revision: editor.revision, change: { values: { name: "n199" } } })
    const again = await client.request("form.evaluate", {
      requestId,
      draft: { ...editor, values: { name: "n199 " }, previous: { name: "" } },
    })
    expect(again).toEqual(evaluation)
    expect(changes).toBe(200)
    expect(run.mock.calls.length).toBe(0)
    // Mutations still go through the ledger.
    expect(
      await client.request("form.submit", { requestId, draft: { ...editor, values: { name: "done" } } }),
    ).toMatchObject({ status: "accepted" })
    expect(run.mock.calls.map(([, , payload]) => (payload as { op: string }).op)).toEqual(["form.submit"])
  } finally {
    run.mockRestore()
  }
  expect(await answer).toEqual({ name: "done" })
})

test("a client forgotten by the ledger is refused at hello; a fresh clientId attaches", async () => {
  let time = 1_000
  const f = await fixture({ idleScopeMs: 1_000, now: () => time })
  const first = f.connect({ clientId: "forgotten-client" })
  await first.client.ready
  expect(await first.client.request("permissions.cycle", {}, { operationId: "cycle-1" })).toMatchObject({
    mode: expect.any(String),
  })
  first.client.close()
  await first.server.closed
  // Detached with no grace: still remembered until it has been idle for idleScopeMs.
  time = 1_999
  const early = f.connect({ clientId: "forgotten-client" })
  await early.client.ready
  early.client.close()
  await early.server.closed
  time = 2_000
  const refused = f.connect({ clientId: "forgotten-client" })
  await expect(refused.client.ready).rejects.toMatchObject({ code: "permission_denied" })
  const fresh = f.connect({ clientId: "new-client" })
  await fresh.client.ready
  expect(await fresh.client.request("permissions.cycle", {}, { operationId: "cycle-1" })).toMatchObject({
    mode: expect.any(String),
  })
})
