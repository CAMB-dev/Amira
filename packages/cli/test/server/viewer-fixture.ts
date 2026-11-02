import "./offline.ts"
import { afterEach, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ExtensionAPI } from "@amira/api"
import { RemoteConnection, type RemoteIO } from "../../src/remote/connection.ts"
import {
  ATTACH_INTENTS,
  ATTACH_ROLES,
  type RemoteAttachment,
  type RemoteHello,
  type RemoteMessage,
} from "../../src/remote/protocol.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime, type WorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"

export const caps = {
  legacy: [] as string[],
  roles: [ATTACH_ROLES],
  viewer: [ATTACH_INTENTS.viewer],
  auto: [ATTACH_INTENTS.auto],
  take: [ATTACH_INTENTS.take],
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

export async function eventually(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}

type ModelProxy = NonNullable<WorkspaceRuntime["modelProxy"]>
/** Records the daemon's model-proxy calls without routing any model traffic. */
export function fakeModelProxy() {
  const attached: RemoteConnection[] = []
  const received: RemoteConnection[] = []
  const proxy: ModelProxy = {
    attach: (connection: RemoteConnection) => {
      attached.push(connection)
    },
    admit: () => {},
    receive: (connection: RemoteConnection) => {
      received.push(connection)
    },
    close: () => {},
    describeBindings: () => [],
    bindMetadata: () => {},
  } as unknown as ModelProxy
  return { proxy, attached, received }
}

/**
 * One workspace runtime with roles on (as on Linux daemons), no heartbeat and an adjustable
 * controller clock. Every client traverses the real codec over in-memory bytes.
 */
export async function viewerFixture(
  options: { graceMs?: number; modelProxy?: ModelProxy; replies?: { text: string; delayMs?: number }[] } = {},
) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-viewers-"))
  let api!: ExtensionAPI
  let time = 10_000
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    ...(options.modelProxy ? { modelProxy: options.modelProxy } : {}),
    ai: createAi({
      dialects: [createMockDialect(options.replies ?? [{ text: "viewer fixture reply" }])],
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
  const authority = workspaceAttachments(runtime, {
    graceMs: options.graceMs ?? 0,
    heartbeatMs: 0,
    roles: true,
    now: () => time,
  })
  const connections: RemoteConnection[] = []
  const connect = (
    capabilities: string[],
    extra: Partial<RemoteHello> & { stallAfterWrites?: number } = {},
  ) => {
    const { stallAfterWrites, ...fields } = extra
    const pipes = loopback(41)
    let writes = 0
    // A peer that stops reading: server writes after the first few never complete.
    const serverIO: RemoteIO =
      stallAfterWrites === undefined
        ? pipes.server
        : {
            ...pipes.server,
            write: (bytes) =>
              ++writes > stallAfterWrites ? new Promise<void>(() => {}) : pipes.server.write(bytes),
          }
    const server = authority.connect(serverIO, { workspace: cwd, release: hello.release })
    const frames: RemoteMessage[] = []
    const client = new RemoteConnection(pipes.client, {
      handshake: {
        role: "client",
        hello: { ...hello, workspace: cwd, capabilities, ...fields },
      },
      onMessage: (message) => frames.push(message),
    })
    client.ready.catch(() => {})
    connections.push(client, server)
    const presence = () =>
      frames.filter((frame): frame is RemoteAttachment => frame.kind === "attachment").at(-1)
    const events = () =>
      frames.flatMap((frame) => (frame.kind === "event" || frame.kind === "reset" ? [frame.seq] : []))
    return { client, server, frames, presence, events }
  }
  cleanup.push(async () => {
    for (const connection of connections) connection.close()
    await Promise.all(connections.map((connection) => connection.closed))
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  return {
    cwd,
    runtime,
    authority,
    connect,
    api: () => api,
    advance(ms: number) {
      time += ms
    },
  }
}

/** The failure a closed client saw, as a plain { code } for matching. */
export async function closedWith(client: RemoteConnection): Promise<string | undefined> {
  await client.closed
  return (client.failureReason as { code?: string } | undefined)?.code
}
