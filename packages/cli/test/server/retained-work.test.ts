import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteHello } from "../../src/remote/protocol.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback } from "../remote/loopback.ts"

async function eventually(check: () => boolean) {
  const end = Date.now() + 1000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}

async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-retained-work-"))
  let time = 1000
  let calls = 0
  let cancelled = false
  let release!: () => void
  const work = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    ai: createAi({
      dialects: [createMockDialect([])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [
      {
        source: "fixture",
        extension: (api) => {
          api.registerCommand({
            name: "wait",
            description: "Wait for test release",
            async run(_args, ctx) {
              calls++
              const abort = () => {
                cancelled = true
                release()
              }
              ctx.signal.addEventListener("abort", abort, { once: true })
              try {
                await work
              } finally {
                ctx.signal.removeEventListener("abort", abort)
              }
            },
          })
        },
      },
    ],
  })
  const authority = workspaceAttachments(runtime, { graceMs: 10, heartbeatMs: 0, now: () => time })
  const connect = (resume?: RemoteHello["resume"], dropResponseId?: string) => {
    const io = loopback()
    const server = authority.connect(
      {
        ...io.server,
        async write(bytes) {
          const text = new TextDecoder().decode(bytes)
          if (
            dropResponseId &&
            text.includes('"kind":"response"') &&
            text.includes(`"id":"${dropResponseId}"`)
          )
            return
          await io.server.write(bytes)
        },
      },
      { workspace: cwd, release: hello.release },
    )
    const client = new RemoteConnection(io.client, {
      handshake: { role: "client", hello: { ...hello, workspace: cwd, ...(resume ? { resume } : {}) } },
    })
    return { client, server }
  }
  return {
    runtime,
    connect,
    calls: () => calls,
    cancelled: () => cancelled,
    advance: () => {
      time += 20
    },
    release,
    async close() {
      release()
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

for (const freshToken of [false, true])
  test(`retained operation cancellation survives ${freshToken ? "fresh-token" : "same-token"} recovery`, async () => {
    const f = await fixture()
    let active: ReturnType<typeof f.connect> | undefined
    try {
      active = f.connect()
      const welcome = await active.client.ready
      const lost = active.client
        .request("command.run", { line: "/wait" }, { operationId: "held-command" })
        .catch(() => {})
      await eventually(() => f.calls() === 1)
      active.client.close()
      await active.server.closed
      await lost
      expect(f.cancelled()).toBe(false)
      if (freshToken) f.advance()
      active = f.connect(
        freshToken
          ? undefined
          : {
              daemonEpoch: welcome.daemonEpoch,
              after: f.runtime.journal.watermark,
              controllerToken: welcome.controllerToken!,
            },
      )
      const next = await active.client.ready
      expect(next.controllerToken === welcome.controllerToken).toBe(!freshToken)
      const abort = new AbortController()
      const retry = active.client
        .request("command.run", { line: "/wait" }, { operationId: "held-command", signal: abort.signal })
        .catch(() => {})
      // A correlated read confirms that the retry has reached the dispatcher before cancellation.
      await active.client.request("state.read", {})
      abort.abort()
      await retry
      await eventually(() => f.cancelled())
      expect(f.calls()).toBe(1)
    } finally {
      active?.client.close()
      active?.server.close()
      await f.close()
    }
  }, 10_000)

test("closed retry transports are collected while their single admitted operation remains pending", async () => {
  const f = await fixture()
  try {
    let resume: RemoteHello["resume"]
    const cycle = async () => {
      const { client, server } = f.connect(resume)
      try {
        const welcome = await client.ready
        const pending = client
          .request("command.run", { line: "/wait" }, { operationId: "pending-command" })
          .catch(() => {})
        await client.request("state.read", {})
        resume = {
          daemonEpoch: welcome.daemonEpoch,
          after: f.runtime.journal.watermark,
          controllerToken: welcome.controllerToken!,
        }
        client.close()
        await server.closed
        await pending
        return new WeakRef(server)
      } finally {
        client.close()
        server.close()
      }
    }
    const references: WeakRef<RemoteConnection>[] = []
    for (let i = 0; i < 100; i++) references.push(await cycle())
    // Run GC and deref inside a fresh timer callback, not the resumed async test frame:
    // JSC can conservatively retain a previous deref result in that frame across awaits.
    // Only indexes escape the callback; its target references and WeakRef keep-alive job
    // have ended before the next GC. This also lets pipe/iterator cleanup finish after close.
    let retained: number[] = []
    for (let attempt = 0; attempt < 20; attempt++) {
      retained = await new Promise<number[]>((resolve) => {
        setTimeout(() => {
          Bun.gc(true)
          resolve(references.flatMap((reference, index) => (reference.deref() ? [index] : [])))
        }, 1)
      })
      if (!retained.length) break
    }
    expect(f.calls()).toBe(1)
    expect(f.cancelled()).toBe(false)
    expect(retained).toHaveLength(0)
  } finally {
    await f.close()
  }
}, 15_000)

test("a read reusing a pending mutation id cannot remove its retained cancellation controller", async () => {
  const f = await fixture()
  let active: ReturnType<typeof f.connect> | undefined
  try {
    active = f.connect()
    let welcome = await active.client.ready
    const lost = active.client
      .request("command.run", { line: "/wait" }, { operationId: "shared-id" })
      .catch(() => {})
    await eventually(() => f.calls() === 1)
    active.client.close()
    await active.server.closed
    await lost
    const resume = () => ({
      daemonEpoch: welcome.daemonEpoch,
      after: f.runtime.journal.watermark,
      controllerToken: welcome.controllerToken!,
    })
    active = f.connect(resume())
    welcome = await active.client.ready
    expect(await active.client.request("state.read", {}, { operationId: "shared-id" })).toMatchObject({
      status: "idle",
    })
    active.client.close()
    await active.server.closed
    active = f.connect(resume())
    await active.client.ready
    const abort = new AbortController()
    const retry = active.client
      .request("command.run", { line: "/wait" }, { operationId: "shared-id", signal: abort.signal })
      .catch(() => {})
    await active.client.request("state.read", {})
    abort.abort()
    await retry
    await eventually(() => f.cancelled())
    expect(f.calls()).toBe(1)
  } finally {
    active?.client.close()
    active?.server.close()
    await f.close()
  }
}, 10_000)

for (const reconnect of [false, true])
  test(`an admitted command remains cancellable across session replacement${reconnect ? " and reconnect" : ""}`, async () => {
    const f = await fixture()
    let active: ReturnType<typeof f.connect> | undefined
    try {
      active = f.connect()
      const welcome = await active.client.ready
      const abort = new AbortController()
      const original = active.client
        .request("command.run", { line: "/wait" }, { operationId: "old-session", signal: abort.signal })
        .catch(() => {})
      await eventually(() => f.calls() === 1)
      expect(await active.client.request("session.clear", {})).toEqual({ sessionGeneration: 2 })
      let observed = original
      if (reconnect) {
        active.client.close()
        await active.server.closed
        await original
        active = f.connect({
          daemonEpoch: welcome.daemonEpoch,
          after: f.runtime.journal.watermark,
          controllerToken: welcome.controllerToken!,
        })
        await active.client.ready
        observed = active.client
          .request(
            "command.run",
            { line: "/wait" },
            { operationId: "old-session", sessionGeneration: 1, signal: abort.signal },
          )
          .catch(() => {})
      }
      await active.client.request("state.read", {}, { sessionGeneration: 2 })
      abort.abort()
      await observed
      await eventually(() => f.cancelled())
      expect(await active.client.request("state.read", {}, { sessionGeneration: 2 })).toMatchObject({
        status: "idle",
      })
      expect(f.calls()).toBe(1)
    } finally {
      active?.client.close()
      active?.server.close()
      await f.close()
    }
  }, 10_000)

for (const mismatch of ["controller", "operation", "unknown"] as const)
  test(`session replacement does not authorize an unrelated stale ${mismatch} cancellation`, async () => {
    const f = await fixture()
    const active = f.connect()
    try {
      const welcome = await active.client.ready
      const pending = active.client
        .request("command.run", { line: "/wait" }, { operationId: "owned-command" })
        .catch(() => {})
      await eventually(() => f.calls() === 1)
      await active.client.request("session.clear", {})
      let closed = false
      void active.server.closed.then(() => {
        closed = true
      })
      await active.client.send({
        v: 1,
        kind: "cancel",
        channel: "control",
        id: mismatch === "unknown" ? "unknown-command" : "owned-command",
        controllerGeneration:
          mismatch === "controller" ? welcome.controllerGeneration + 1 : welcome.controllerGeneration,
        sessionGeneration: mismatch === "operation" ? 2 : 1,
      })
      await eventually(() => closed)
      await pending
      expect(f.cancelled()).toBe(false)
      await expect(active.server.request("state.read", {})).rejects.toMatchObject({ code: "invalid_frame" })
    } finally {
      active.client.close()
      active.server.close()
      await f.close()
    }
  }, 10_000)

test("cancelling a read observation cannot abort an unrelated retained mutation with the same id", async () => {
  const f = await fixture()
  let active: ReturnType<typeof f.connect> | undefined
  try {
    active = f.connect()
    let welcome = await active.client.ready
    const lost = active.client
      .request("command.run", { line: "/wait" }, { operationId: "shared-observation" })
      .catch(() => {})
    await eventually(() => f.calls() === 1)
    active.client.close()
    await active.server.closed
    await lost
    const resume = () => ({
      daemonEpoch: welcome.daemonEpoch,
      after: f.runtime.journal.watermark,
      controllerToken: welcome.controllerToken!,
    })
    active = f.connect(resume(), "shared-observation")
    welcome = await active.client.ready
    const abortRead = new AbortController()
    const read = active.client
      .request("state.read", {}, { operationId: "shared-observation", signal: abortRead.signal })
      .catch(() => {})
    await active.client.request("state.read", {})
    expect(await active.client.request("session.clear", {})).toEqual({ sessionGeneration: 2 })
    abortRead.abort()
    await read
    await active.client.request("state.read", {}, { sessionGeneration: 2 })
    expect(f.cancelled()).toBe(false)
    active.client.close()
    await active.server.closed
    active = f.connect(resume())
    await active.client.ready
    const abortMutation = new AbortController()
    const mutation = active.client
      .request(
        "command.run",
        { line: "/wait" },
        { operationId: "shared-observation", sessionGeneration: 1, signal: abortMutation.signal },
      )
      .catch(() => {})
    await active.client.request("state.read", {})
    abortMutation.abort()
    await mutation
    await eventually(() => f.cancelled())
    expect(f.calls()).toBe(1)
  } finally {
    active?.client.close()
    active?.server.close()
    await f.close()
  }
}, 10_000)

test("a late cancellation for a completed result lost before a switch remains scoped to its admitted generation", async () => {
  const f = await fixture()
  const active = f.connect(undefined, "completed-command")
  try {
    await active.client.ready
    const abort = new AbortController()
    const result = active.client
      .request("command.run", { line: "/wait" }, { operationId: "completed-command", signal: abort.signal })
      .catch(() => {})
    await eventually(() => f.calls() === 1)
    f.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await active.client.request("session.clear", {})).toEqual({ sessionGeneration: 2 })
    abort.abort()
    await result
    expect(await active.client.request("state.read", {}, { sessionGeneration: 2 })).toMatchObject({
      status: "idle",
    })
    expect(f.cancelled()).toBe(false)
  } finally {
    active.client.close()
    active.server.close()
    await f.close()
  }
}, 10_000)

test("a retained cancellation from a new attachment must use the admitted operation channel", async () => {
  const f = await fixture()
  let active: ReturnType<typeof f.connect> | undefined
  try {
    active = f.connect()
    const first = await active.client.ready
    const pending = active.client
      .request("command.run", { line: "/wait" }, { operationId: "channel-owned" })
      .catch(() => {})
    await eventually(() => f.calls() === 1)
    active.client.close()
    await active.server.closed
    await pending
    active = f.connect({
      daemonEpoch: first.daemonEpoch,
      after: f.runtime.journal.watermark,
      controllerToken: first.controllerToken!,
    })
    const current = await active.client.ready
    let closed = false
    void active.server.closed.then(() => {
      closed = true
    })
    await active.client.send({
      v: 1,
      kind: "cancel",
      channel: "model",
      id: "channel-owned",
      controllerGeneration: current.controllerGeneration,
      sessionGeneration: 1,
    })
    await eventually(() => closed)
    expect(f.cancelled()).toBe(false)
  } finally {
    active?.client.close()
    active?.server.close()
    await f.close()
  }
}, 10_000)
