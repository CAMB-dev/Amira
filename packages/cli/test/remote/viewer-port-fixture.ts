import "../server/offline.ts"
import { afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { RemoteAgentPort, type RemoteAttachIntent } from "../../src/remote/agent-port.ts"
import type { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteRelease } from "../../src/remote/protocol.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback, welcome } from "./loopback.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

/**
 * One workspace runtime with roles forced on (as on Linux daemons, so this runs on every OS)
 * and several codec-backed RemoteAgentPorts. Each port records the operations it put on the wire.
 */
export async function viewerPortFixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-viewer-port-"))
  let time = 10_000
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    ai: createAi({
      dialects: [createMockDialect([{ text: "viewer port reply" }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [],
  })
  const authority = workspaceAttachments(runtime, {
    graceMs: 30_000,
    heartbeatMs: 0,
    roles: true,
    now: () => time,
  })
  const ports: RemoteAgentPort[] = []
  const servers: RemoteConnection[] = []
  async function open(
    clientId: string,
    options: { intent?: RemoteAttachIntent; release?: RemoteRelease } = {},
  ) {
    const sent: string[] = []
    let server: RemoteConnection | undefined
    const port = new RemoteAgentPort({
      hello: {
        ...hello,
        workspace: cwd,
        clientId,
        ...(options.release ? { release: options.release } : {}),
      },
      intent: options.intent ?? "auto",
      async connect() {
        const io = loopback()
        server = authority.connect(io.server, { release: welcome.release, workspace: cwd })
        servers.push(server)
        return {
          ...io.client,
          async write(bytes) {
            for (const line of Buffer.from(bytes).toString().split("\n")) {
              const op = /"kind":"request".*?"op":"([^"]+)"/.exec(line)?.[1]
              if (op) sent.push(op)
            }
            await io.client.write(bytes)
          },
        }
      },
    })
    ports.push(port)
    await port.reconnect()
    // The daemon side ends this port's current connection, as a lost network would.
    return { port, sent, drop: () => server?.close() }
  }
  cleanup.push(async () => {
    for (const port of ports) await port.detach()
    for (const server of servers) server.close()
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  return {
    cwd,
    runtime,
    open,
    /** The controller change rule counts real time; tests move this clock past it. */
    advance(ms: number) {
      time += ms
    },
  }
}

export async function until(predicate: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for viewer port state")
    await Bun.sleep(2)
  }
}
