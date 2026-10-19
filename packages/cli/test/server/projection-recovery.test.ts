import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteHello, RemoteMessage } from "../../src/remote/protocol.ts"
import { type RemoteWorkspaceSnapshot, validateRemoteDto } from "../../src/remote-schema.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"

async function eventually(check: () => boolean) {
  const end = Date.now() + 10_000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}

test("20,001 real model deltas remain bounded midstream, settle, and reattach through the codec", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-projection-recovery-"))
  const hold = Promise.withResolvers<void>()
  const text = "abcdefgh".repeat(20_001)
  let held = false
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    ai: createAi({
      dialects: [
        createMockDialect([
          {
            text,
            hold: {
              chunks: 20_000,
              get until() {
                held = true
                return hold.promise
              },
            },
          },
        ]),
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [],
  })
  const authority = workspaceAttachments(runtime, { graceMs: 10_000, heartbeatMs: 0 })
  const connections: RemoteConnection[] = []
  const connect = (resume?: RemoteHello["resume"]) => {
    const io = loopback(4096)
    const frames: RemoteMessage[] = []
    const server = authority.connect(io.server, { workspace: cwd, release: hello.release })
    const client = new RemoteConnection(io.client, {
      handshake: {
        role: "client",
        hello: { ...hello, workspace: cwd, ...(resume ? { resume } : {}), snapshot: true },
      },
      onMessage: (frame) => frames.push(frame),
    })
    connections.push(client, server)
    return { client, server, frames }
  }
  let deltas = 0
  let settled = false
  const originals: string[] = []
  const cut = runtime.journal.open(
    undefined,
    () => runtime.workspaceSnapshot(),
    (event) => {
      const payload = event.payload
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return
      if (payload.type === "message.delta") {
        deltas++
        if (deltas === 1 || deltas === 20_001) originals.push(JSON.stringify(payload.data))
      }
      if (payload.type === "turn.end") settled = true
    },
  )
  try {
    const first = connect()
    const welcome = await first.client.ready
    await eventually(() => first.frames.some((frame) => frame.kind === "reset"))
    first.client.close()
    await first.server.closed
    // Stream detached so transport queue limits cannot mask the projection regression.
    const local = runtime.attach()
    await local.execute("turn.prompt", { message: "stream a long reply" })
    await local.detach()
    await eventually(() => held)
    const partial = runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    validateRemoteDto("workspaceSnapshot", partial)
    const partials = partial.activity.events.filter((event) => event.type === "message.delta")
    expect(partials).toHaveLength(1)
    expect(partials[0]!.data).toEqual({ kind: "text", text: "abcdefgh".repeat(20_000) })
    expect(partial.activity.events.length).toBeLessThan(20)
    hold.resolve()
    await eventually(() => settled)
    const complete = runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    validateRemoteDto("workspaceSnapshot", complete)
    expect(complete.frontend.state.status).toBe("idle")
    expect(complete.frontend.sessionGeneration).toBe(partial.frontend.sessionGeneration)
    expect(complete.activity.events.some((event) => event.type === "message.delta")).toBe(false)
    expect(JSON.stringify(complete.frontend.transcript)).toContain(text)
    expect(deltas).toBe(20_001)
    expect(originals).toEqual([
      JSON.stringify({ kind: "text", text: "abcdefgh" }),
      JSON.stringify({ kind: "text", text: "abcdefgh" }),
    ])
    // A previously returned snapshot must remain immutable after the final delta/settlement.
    expect(partials[0]!.data).toEqual({ kind: "text", text: "abcdefgh".repeat(20_000) })
    const second = connect({
      daemonEpoch: welcome.daemonEpoch,
      after: runtime.journal.watermark,
      controllerToken: welcome.controllerToken!,
    })
    await second.client.ready
    await eventually(() => second.frames.some((frame) => frame.kind === "reset"))
    const reset = second.frames.find((frame) => frame.kind === "reset")!
    if (reset.kind !== "reset") throw new Error("Expected reset")
    validateRemoteDto("workspaceSnapshot", reset.snapshot)
    expect(JSON.stringify(reset.snapshot)).toContain(text)
    expect(await second.client.request("state.read", {})).toMatchObject({ status: "idle" })
  } finally {
    hold.resolve()
    cut.close()
    for (const connection of connections) connection.close()
    await Promise.all(connections.map((connection) => connection.closed))
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}, 30_000)
