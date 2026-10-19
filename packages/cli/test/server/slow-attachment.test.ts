import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ExtensionAPI } from "@amira/api"
import { RemoteConnection, type RemoteIO } from "../../src/remote/connection.ts"
import { REMOTE_LIMITS, type RemoteHello, type RemoteMessage } from "../../src/remote/protocol.ts"
import { type RemoteWorkspaceSnapshot, validateRemoteDto } from "../../src/remote-schema.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Expected attachment progress did not arrive")), 4000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function eventually(check: () => boolean) {
  const end = Date.now() + 4000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}

/** A stalled sink still honors RemoteIO.close's obligation to interrupt a pending write. */
function slowSink(io: RemoteIO) {
  let paused = false
  let closed = false
  let blocked = 0
  let interrupted = 0
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const remote: RemoteIO = {
    input: io.input,
    async write(bytes) {
      if (paused && !closed) {
        blocked++
        enter()
        try {
          await gate
        } finally {
          blocked--
        }
        if (closed) {
          interrupted++
          throw new Error("Slow fixture sink closed")
        }
      }
      if (closed) throw new Error("Slow fixture sink closed")
      await io.write(bytes)
    },
    close() {
      closed = true
      release()
      io.close()
    },
  }
  return {
    remote,
    entered,
    pause: () => {
      paused = true
    },
    blocked: () => blocked,
    interrupted: () => interrupted,
  }
}

function resetSnapshot(frames: RemoteMessage[]): RemoteWorkspaceSnapshot {
  const reset = frames.find((frame) => frame.kind === "reset")
  if (reset?.kind !== "reset") throw new Error("Expected workspace reset")
  validateRemoteDto("workspaceSnapshot", reset.snapshot)
  return reset.snapshot as unknown as RemoteWorkspaceSnapshot
}

test("a stalled attachment exceeding 1024 queued notifications closes only its transport; approval and same-token snapshot reattach survive", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-slow-attachment-"))
  let api!: ExtensionAPI
  let invocations = 0
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
        extension: (value) => {
          api = value
          api.registerCommand({
            name: "approval",
            description: "Fixture approval",
            run: async (_args, ctx) => {
              invocations++
              ctx.print(
                (await api.ui.confirm("Approval survives a slow transport")) ? "approved" : "declined",
              )
            },
          })
        },
      },
    ],
  })
  const authority = workspaceAttachments(runtime, { heartbeatMs: 0 })
  const connections: RemoteConnection[] = []
  const connect = (resume?: RemoteHello["resume"], slow = false) => {
    const io = loopback(37)
    const sink = slowSink(io.server)
    const frames: RemoteMessage[] = []
    const server = authority.connect(slow ? sink.remote : io.server, {
      workspace: cwd,
      release: hello.release,
    })
    const client = new RemoteConnection(io.client, {
      handshake: {
        role: "client",
        hello: { ...hello, workspace: cwd, snapshot: true, ...(resume ? { resume } : {}) },
      },
      onMessage: (frame) => frames.push(frame),
    })
    connections.push(client, server)
    return { client, server, sink, frames }
  }
  try {
    const first = connect(undefined, true)
    const welcome = await deadline(first.client.ready)
    await eventually(() => first.frames.some((frame) => frame.kind === "reset"))
    const lost = first.client
      .request("command.run", { line: "/approval" }, { operationId: "slow-approval-1" })
      .catch((error) => error)
    await eventually(() =>
      first.frames.some(
        (frame) => frame.kind === "event" && JSON.stringify(frame.payload).includes('"type":"ui.request"'),
      ),
    )
    const before = runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    expect(before.pendingRequests).toHaveLength(1)
    const request = before.pendingRequests[0]!
    const after = runtime.journal.watermark

    first.sink.pause()
    api.notify("Block the next write")
    await deadline(first.sink.entered)
    expect(first.sink.blocked()).toBe(1)
    // Small frames hit the frame-count bound, not the byte limit. The first write is in flight.
    for (let i = 0; i < REMOTE_LIMITS.queuedFrames + 2; i++) api.notify(`Slow notification ${i}`)
    await deadline(first.server.closed)
    await deadline(first.client.closed)
    await deadline(lost)
    await eventually(() => first.sink.blocked() === 0)
    expect(first.sink.interrupted()).toBe(1)
    await expect(first.server.request("state.read", {})).rejects.toMatchObject({ code: "limit_exceeded" })
    expect(runtime.signal.aborted).toBe(false)
    expect(runtime.journal.watermark).toBeGreaterThan(after + REMOTE_LIMITS.queuedFrames)
    expect((runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).pendingRequests).toEqual([
      request,
    ])

    api.notify("Still captured after slow transport closed")
    const second = connect({
      daemonEpoch: welcome.daemonEpoch,
      controllerToken: welcome.controllerToken!,
      after,
    })
    const next = await deadline(second.client.ready)
    await eventually(() => second.frames.some((frame) => frame.kind === "reset"))
    expect(next.controllerToken).toBe(welcome.controllerToken)
    expect(next.controllerGeneration).toBeGreaterThan(welcome.controllerGeneration)
    expect(resetSnapshot(second.frames).pendingRequests).toEqual([request])
    expect(await second.client.request("state.read", {})).toMatchObject({
      sessionId: before.frontend.state.sessionId,
    })
    const retry = second.client.request(
      "command.run",
      { line: "/approval" },
      { operationId: "slow-approval-1" },
    )
    expect(await second.client.request("ui.respond", { requestId: request.requestId, value: true })).toEqual({
      status: "accepted",
    })
    expect(await deadline(retry)).toMatchObject({ ok: true, output: ["approved"] })
    expect(invocations).toBe(1)
    expect((runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot).pendingRequests).toEqual([])
    expect(runtime.signal.aborted).toBe(false)
  } finally {
    for (const connection of connections) connection.close()
    await Promise.all(connections.map((connection) => connection.closed))
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}, 15_000)
