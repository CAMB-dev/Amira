import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback, welcome } from "../remote/loopback.ts"

test("runtime command dialogs and host DTOs cross the real bidirectional attachment codec", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-runtime-wire-"))
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai: createAi({
      dialects: [createMockDialect([])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [
      {
        source: "fixture",
        extension: (api) => {
          api.registerCommand({
            name: "confirm",
            description: "test",
            run: async (_args, ctx) => {
              ctx.print((await api.ui.confirm("Approve fixture?")) ? "accepted" : "declined")
            },
          })
        },
      },
    ],
  })
  const attachment = runtime.attach()
  const io = loopback(31)
  let received!: (id: string) => void
  const pending = new Promise<string>((resolve) => {
    received = resolve
  })
  const server = new RemoteConnection(io.server, {
    handshake: { role: "server", accept: () => ({ ...welcome, workspace: cwd }) },
    async handle(request) {
      // Test-owned finite dispatcher. Runtime journalling/admission belongs to B07, not the connection.
      switch (request.op) {
        case "command.run":
          if (typeof request.params.line !== "string") throw new Error("Invalid command")
          return frontendJson(await attachment.execute("command.run", { line: request.params.line }))
        case "ui.respond":
          if (typeof request.params.requestId !== "string") throw new Error("Invalid response")
          return frontendJson(
            await attachment.request("ui.respond", {
              requestId: request.params.requestId,
              value: request.params.value!,
            }),
          )
        case "models.list":
          return frontendJson(await attachment.request("models.list", {}))
        case "status.read":
          return frontendJson(await attachment.request("status.read", {}))
        default:
          throw new Error("Unsupported fixture operation")
      }
    },
  })
  const client = new RemoteConnection(io.client, {
    handshake: { role: "client", hello: { ...hello, workspace: cwd } },
    onMessage(message) {
      if (
        message.kind !== "event" ||
        !message.payload ||
        typeof message.payload !== "object" ||
        Array.isArray(message.payload)
      )
        return
      const data = message.payload.data
      if (
        message.payload.type === "ui.request" &&
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof data.requestId === "string"
      )
        received(data.requestId)
    },
  })
  let seq = 0
  const off = attachment.subscribeEvents((event) => {
    void server
      .send({
        v: 1,
        kind: "event",
        daemonEpoch: welcome.daemonEpoch,
        seq: ++seq,
        payload: frontendJson(event),
      })
      .catch(() => {})
  })
  try {
    const command = client.request("command.run", { line: "/confirm" })
    const requestId = await pending
    expect(await client.request("ui.respond", { requestId, value: true })).toEqual({ status: "accepted" })
    expect(await command).toMatchObject({ ok: true, output: ["accepted"] })
    expect(await client.request("models.list", {})).toMatchObject([{ ref: "mock/test" }])
    expect(await client.request("status.read", {})).toMatchObject({ info: { model: { model: "test" } } })
    client.close()
    await server.closed
    await attachment.detach()
    const next = runtime.attach()
    expect(next.pendingRequests).toHaveLength(0)
    expect(next.snapshot.state.model.id).toBe("test")
    await next.detach()
  } finally {
    off()
    client.close()
    server.close()
    await attachment.detach()
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
