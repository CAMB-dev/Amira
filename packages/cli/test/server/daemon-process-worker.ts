import { createAi, createMockDialect } from "@amira/ai"
import { SessionStore } from "@amira/core"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { loopback } from "../remote/loopback.ts"

// A local fake-SSH relay, deliberately not the parent/owner of the workspace process.
if (process.argv[2] === "relay") {
  process.on("message", (message: { bytes: string }) => {
    process.stdout.write(Buffer.from(message.bytes, "base64"))
  })
  process.stdout.on("error", () => process.exit(0))
  for await (const bytes of process.stdin) process.send!({ bytes: Buffer.from(bytes).toString("base64") })
  process.exit(0)
} else {
  globalThis.fetch = Object.assign(
    () => {
      throw new Error("No network in process fixture")
    },
    { preconnect() {} },
  )
  const runtime = await createWorkspaceRuntime({
    cwd: process.argv[3]!,
    autoTitle: false,
    model: "mock/m",
    builtins: async () => [],
    store: SessionStore.create({ cwd: process.argv[3]! }),
    ai: createAi({
      dialects: [createMockDialect([{ text: "persistent process result", delayMs: 80 }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
  })
  const clients = new Map<string, ReturnType<typeof loopback>["client"]>()
  const authority = workspaceAttachments(runtime)
  process.on("message", async (message: { action: string; id: string; bytes?: string }) => {
    if (message.action === "connect") {
      const pipes = loopback(19)
      clients.set(message.id, pipes.client)
      authority.connect(pipes.server, {
        release: { version: "fixture", buildId: "process-fixture", target: "test-native" },
        workspace: process.argv[3]!,
      })
      try {
        for await (const bytes of pipes.client.input)
          process.send!({ kind: "bytes", id: message.id, bytes: Buffer.from(bytes).toString("base64") })
      } finally {
        clients.delete(message.id)
      }
    } else if (message.action === "bytes") {
      try {
        await clients.get(message.id)?.write(Buffer.from(message.bytes!, "base64"))
      } catch {}
    } else if (message.action === "close") clients.get(message.id)?.close()
    else if (message.action === "inspect") {
      process.send!({
        kind: "inspect",
        id: message.id,
        snapshot: runtime.workspaceSnapshot(),
        idle: runtime.quiescent(),
      })
    } else if (message.action === "stop") {
      for (const client of clients.values()) client.close()
      await runtime.stop()
      process.exit(0)
    }
  })
  process.on("disconnect", () => {
    void runtime.stop().finally(() => process.exit(0))
  })
  process.send!({ kind: "ready", epoch: runtime.journal.daemonEpoch })
}
