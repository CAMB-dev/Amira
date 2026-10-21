import "../server/offline.ts"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { createRemoteAgentPort, type RemoteAgentPortOptions } from "../../src/remote/agent-port.ts"
import type { RemoteConnection, RemoteIO } from "../../src/remote/connection.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime, type WorkspaceRuntimeOptions } from "../../src/server/runtime.ts"
import { hello, loopback, welcome } from "./loopback.ts"

export async function agentPortFixture(
  options: Partial<WorkspaceRuntimeOptions> = {},
  portOptions: Pick<RemoteAgentPortOptions, "brokerPeer"> = {},
  hooks: {
    /** Return false when the hook has already forwarded or discarded the bytes. */
    serverWrite?(bytes: Uint8Array, io: RemoteIO): Promise<false | undefined>
  } = {},
) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-agent-port-"))
  const mock = createMockDialect([{ text: "loopback answer" }])
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai: createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] }),
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [],
    ...options,
  })
  const authority = workspaceAttachments(runtime, { heartbeatMs: 0 })
  let server!: RemoteConnection
  let attempts = 0
  let serverClosed = false
  const port = await createRemoteAgentPort({
    ...portOptions,
    hello: { ...hello, workspace: cwd, clientId: `port-${path.basename(cwd)}` },
    async connect() {
      attempts++
      const io = loopback(53)
      serverClosed = false
      server = authority.connect(
        {
          ...io.server,
          async write(bytes) {
            if ((await hooks.serverWrite?.(bytes, io.server)) !== false) await io.server.write(bytes)
          },
        },
        { release: welcome.release, workspace: cwd },
      )
      const current = server
      void current.closed.then(() => {
        if (server === current) serverClosed = true
      })
      return io.client
    },
  }).catch(async (error) => {
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    throw error
  })
  return {
    port,
    runtime,
    mock,
    get attempts() {
      return attempts
    },
    disconnect() {
      server.close()
    },
    // Client close is not a remote acknowledgement; observe server EOF before local handoff.
    waitForServerClose: () => until(() => serverClosed),
    async close() {
      await port.detach()
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

export async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for loopback state")
}
