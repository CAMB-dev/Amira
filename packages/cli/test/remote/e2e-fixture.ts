import "../server/offline.ts"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRemoteAgentPort, type RemoteAgentPort } from "../../src/remote/agent-port.ts"
import { RemoteConnection, type RemoteIO } from "../../src/remote/connection.ts"
import { ModelBrokerPeer } from "../../src/remote/model-peer.ts"
import type { RemoteHello, RemoteMessage } from "../../src/remote/protocol.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime, type WorkspaceRuntimeOptions } from "../../src/server/runtime.ts"
import { hello, loopback } from "./loopback.ts"
import type { proxyFixture } from "./model-proxy-fixture.ts"

/** One retained runtime and local broker, with independently disposable byte relays.
 * Faults act on encoded lines, never on runtime callbacks or the client reducer.
 * This is in-process loopback, NOT an SSH, daemon-process or native-build test.
 */
export async function e2eFixture(
  model: ReturnType<typeof proxyFixture>,
  options: Partial<WorkspaceRuntimeOptions> = {},
) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-b15-workspace-"))
  const peer = new ModelBrokerPeer(model.broker, { timeoutMs: 30_000 })
  const connections: RemoteConnection[] = []
  const wire: { side: "client" | "server"; text: string; frame: RemoteMessage }[] = []
  const faults = {
    dropResponseId: "",
    droppedResponses: [] as string[],
    dropNextEvent: false,
    droppedEvents: [] as number[],
    duplicateEvents: true,
    dropAcks: true,
    droppedAcks: 0,
  }
  let runtime: Awaited<ReturnType<typeof createWorkspaceRuntime>> | undefined
  let port: RemoteAgentPort | undefined
  let server: RemoteConnection | undefined
  const close = async () => {
    try {
      await port?.detach()
    } finally {
      peer.close()
      for (const connection of connections) connection.close()
      try {
        await Promise.all(connections.map((connection) => connection.closed))
        await runtime?.stop()
      } finally {
        model.close()
        rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  }
  try {
    runtime = await createWorkspaceRuntime({
      cwd,
      ai: model.proxy,
      modelProxy: model.proxy,
      model: "p/m",
      autoTitle: false,
      builtins: async () => [],
      ...options,
    })
    const authority = workspaceAttachments(runtime, { heartbeatMs: 0 })
    const connect = () => {
      // One-byte fragments necessarily split UTF-8 code points as well as JSON tokens.
      const pipes = loopback(1)
      const observe = (side: "client" | "server", io: RemoteIO): RemoteIO => ({
        ...io,
        async write(bytes) {
          const text = Buffer.from(bytes).toString("utf8")
          const frame = JSON.parse(text) as RemoteMessage
          wire.push({ side, text, frame })
          if (side === "client" && frame.kind === "ack" && faults.dropAcks) {
            faults.droppedAcks++
            return
          }
          if (side === "server" && frame.kind === "response" && frame.id === faults.dropResponseId) {
            faults.dropResponseId = ""
            faults.droppedResponses.push(frame.id)
            return
          }
          if (side === "server" && frame.kind === "event" && faults.dropNextEvent) {
            faults.dropNextEvent = false
            faults.droppedEvents.push(frame.seq)
            return
          }
          await io.write(bytes)
          if (side === "server" && frame.kind === "event" && faults.duplicateEvents) await io.write(bytes)
        },
      })
      server = authority.connect(observe("server", pipes.server), { workspace: cwd, release: hello.release })
      connections.push(server)
      return observe("client", pipes.client)
    }
    port = await createRemoteAgentPort({
      hello: { ...hello, workspace: cwd, clientId: `b15-${path.basename(cwd)}` },
      brokerPeer: peer,
      async connect() {
        return connect()
      },
    })
    const activePort = port
    const activeRuntime = runtime
    return {
      port: activePort,
      runtime: activeRuntime,
      wire,
      faults,
      async negotiate() {
        await activePort.request("proxy.bind", { metadata: model.broker.metadata([model.request.model]) })
      },
      async disconnect() {
        const current = server!
        current.close()
        await current.closed
      },
      /** A second codec peer exercises the same production controller/ledger authority. */
      rawClient(overrides: Partial<RemoteHello> = {}) {
        const client = new RemoteConnection(connect(), {
          handshake: {
            role: "client",
            hello: { ...hello, workspace: cwd, clientId: `b15-${path.basename(cwd)}`, ...overrides },
          },
        })
        connections.push(client)
        return client
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

export async function eventually(label: string, check: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`B15 timed out: ${label}`)
    await Bun.sleep(5)
  }
}
