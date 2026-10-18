import "../server/offline.ts"
import { expect, test } from "bun:test"
import { RemoteDecoder } from "../../src/remote/codec.ts"
import { RemoteConnection, type RemoteConnectionOptions } from "../../src/remote/connection.ts"
import { RemoteReplyError } from "../../src/remote/errors.ts"
import { REMOTE_LIMITS, type RemoteMessage } from "../../src/remote/protocol.ts"
import { RemoteWriter } from "../../src/remote/writer.ts"
import { hello, loopback, welcome } from "./loopback.ts"
import { modelParams, operationFixtures, state } from "./schema-fixtures.ts"

function pair(handle?: RemoteConnectionOptions["handle"], clientHandle?: RemoteConnectionOptions["handle"]) {
  const io = loopback(17)
  const server = new RemoteConnection(io.server, {
    handshake: { role: "server", accept: () => welcome },
    handle,
  })
  const client = new RemoteConnection(io.client, {
    handshake: { role: "client", hello },
    handle: clientHandle,
  })
  return { client, server }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("simultaneous bidirectional model/control requests correlate out of order without blocking the reader", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const { client, server } = pair(
    async (request) => {
      if (request.params.line === "/wait") await held
      return operationFixtures[request.op].result
    },
    async (request) => operationFixtures[request.op].result,
  )
  try {
    await Promise.all([client.ready, server.ready])
    const slow = client.request("command.run", { line: "/wait" })
    expect(await client.request("state.read", {})).toEqual(state)
    expect(await server.request("model.stream", modelParams)).toEqual({ accepted: true })
    release()
    expect(await slow).toEqual(operationFixtures["command.run"].result)
  } finally {
    release()
    client.close()
    server.close()
  }
})

test("abort propagates to a remote handler and late results do not resurrect a cancelled request", async () => {
  let started!: () => void
  let cancelled!: () => void
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const cancel = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const { client, server } = pair(async (_request, signal) => {
    started()
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          cancelled()
          resolve()
        },
        { once: true },
      ),
    )
    return operationFixtures["turn.prompt"].result
  })
  try {
    const controller = new AbortController()
    const request = client.request("turn.prompt", { message: "hi" }, { signal: controller.signal })
    const rejection = request.catch((error) => error)
    await start
    controller.abort()
    expect(await rejection).toMatchObject({ code: "cancelled" })
    await cancel
  } finally {
    client.close()
    server.close()
  }
})

test("cancellation before handshake acceptance is immediate and executes nothing", async () => {
  const io = loopback()
  const client = new RemoteConnection(io.client, { handshake: { role: "client", hello } })
  try {
    const signal = new AbortController()
    const request = client.request("state.read", {}, { signal: signal.signal })
    signal.abort()
    await expect(request).rejects.toMatchObject({ code: "cancelled" })
  } finally {
    client.close()
  }
})

test("cancel during a chunked request cannot overtake its admission", async () => {
  let cancelled!: () => void
  const observed = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const { client, server } = pair(async (_request, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          cancelled()
          resolve()
        },
        { once: true },
      ),
    )
    return operationFixtures["turn.prompt"].result
  })
  try {
    await client.ready
    const controller = new AbortController()
    const result = client
      .request("turn.prompt", { message: "x".repeat(800_000) }, { signal: controller.signal })
      .catch((error) => error)
    // The send has begun, but fragmentation/backpressure has not delivered a logical request yet.
    await Promise.resolve()
    controller.abort()
    expect(await result).toMatchObject({ code: "cancelled" })
    await observed
  } finally {
    client.close()
    server.close()
  }
})

test("outgoing pending requests are bounded; closing rejects every waiter", async () => {
  const { client, server } = pair(async (_request, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    return state
  })
  try {
    await client.ready
    const pending = Array.from({ length: REMOTE_LIMITS.pendingRequests }, () =>
      client.request("state.read", {}).catch((error) => error.code),
    )
    await expect(client.request("state.read", {})).rejects.toMatchObject({ code: "limit_exceeded" })
    client.close()
    expect(await Promise.all(pending)).toEqual(Array(REMOTE_LIMITS.pendingRequests).fill("disconnected"))
    await server.closed
  } finally {
    client.close()
    server.close()
  }
})

test("terminal output failure closes the connection and rejects already-sent pending requests", async () => {
  const io = loopback()
  let fail = false
  let started!: () => void
  let cancelled = false
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const server = new RemoteConnection(io.server, {
    handshake: { role: "server", accept: () => welcome },
    async handle(_request, signal) {
      started()
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true
            resolve()
          },
          { once: true },
        ),
      )
      return state
    },
  })
  const client = new RemoteConnection(
    {
      ...io.client,
      async write(bytes) {
        if (fail) throw new Error("terminal sink failure")
        await io.client.write(bytes)
      },
    },
    { handshake: { role: "client", hello } },
  )
  try {
    const prior = client.request("state.read", {}).catch((error) => error)
    await start
    fail = true
    await expect(client.request("state.read", {})).rejects.toThrow("terminal sink failure")
    expect(await Promise.race([client.closed.then(() => true), tick().then(() => false)])).toBe(true)
    expect(await prior).toBeInstanceOf(Error)
    await server.closed
    expect(cancelled).toBe(true)
  } finally {
    client.close()
    server.close()
  }
})

test("unknown handler exceptions are not reflected onto the wire", async () => {
  const { client, server } = pair(async () => {
    throw new Error("SENTINEL_PROVIDER_SECRET")
  })
  try {
    await expect(client.request("state.read", {})).rejects.toThrow("Remote operation failed")
    await expect(client.request("state.read", {})).rejects.not.toThrow("SENTINEL")
  } finally {
    client.close()
    server.close()
  }
})

test("a handler's malformed result is rejected before sending a successful response", async () => {
  const { client, server } = pair(async () => ({ ...state, unexpected: true }))
  try {
    await expect(client.request("state.read", {})).rejects.toMatchObject({ code: "invalid_frame" })
  } finally {
    client.close()
    server.close()
  }
})

test("local malformed params execute no handler and leave the connection usable", async () => {
  let calls = 0
  const { client, server } = pair(async (request) => {
    calls++
    return operationFixtures[request.op].result
  })
  try {
    await client.ready
    await expect(
      client.request("fastMode.set", { enabled: "false", extra: "unexpected" }),
    ).rejects.toMatchObject({ code: "invalid_frame" })
    expect(calls).toBe(0)
    expect(await client.request("state.read", {})).toEqual(state)
    expect(calls).toBe(1)
  } finally {
    client.close()
    server.close()
  }
})

test("validated host failures preserve stable codes across JSON", async () => {
  const { client, server } = pair(async () => {
    throw new RemoteReplyError("agent_busy", "Busy")
  })
  try {
    await expect(client.request("turn.prompt", { message: "hi" })).rejects.toMatchObject({
      code: "agent_busy",
      message: "Busy",
    })
  } finally {
    client.close()
    server.close()
  }
})

test("writer serializes sinks, honors backpressure and interleaves bounded model/control/file chunks", async () => {
  const decoder = new RemoteDecoder()
  const delivered: RemoteMessage[] = []
  const channels: string[] = []
  let busy = false
  let release!: () => void
  let writes = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writer = new RemoteWriter(async (bytes) => {
    expect(busy).toBe(false)
    busy = true
    if (++writes === 1) await gate
    channels.push(JSON.parse(new TextDecoder().decode(bytes)).channel ?? "control")
    delivered.push(...decoder.push(bytes))
    await tick()
    busy = false
  })
  const model = writer.send({
    v: 1,
    kind: "model.event",
    callId: "call-1",
    seq: 1,
    event: { type: "text.delta", text: "m".repeat(800_000) },
  })
  const file = writer.send({
    v: 1,
    kind: "response",
    channel: "files",
    id: "f1",
    op: "transcript.read",
    ok: true,
    result: {
      messages: [],
      displays: [{ id: "d1", before: 0, level: "info", text: "f".repeat(800_000), options: {} }],
    },
  })
  const control = writer.send({ v: 1, kind: "cancel", channel: "control", id: "c1" })
  expect(writes).toBe(1)
  release()
  try {
    await Promise.all([model, file, control])
    decoder.finish()
    expect(delivered[0]?.kind).toBe("cancel")
    expect(delivered).toHaveLength(3)
    expect(channels.slice(0, 4)).toContain("control")
    expect(channels.slice(0, 4)).toContain("model")
    expect(channels.slice(0, 4)).toContain("files")
  } finally {
    writer.close()
  }
})

test("a model terminal reply never overtakes queued stream events", async () => {
  const delivered: RemoteMessage[] = []
  const decoder = new RemoteDecoder()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  const writer = new RemoteWriter(async (bytes) => {
    if (++writes === 1) await gate
    delivered.push(...decoder.push(bytes))
  })
  const first = writer.send({
    v: 1,
    kind: "model.event",
    callId: "call-1",
    seq: 1,
    event: { type: "text.delta", text: "delta one" },
  })
  const second = writer.send({
    v: 1,
    kind: "model.event",
    callId: "call-1",
    seq: 2,
    event: { type: "text.delta", text: "delta two" },
  })
  const terminal = writer.send({
    v: 1,
    kind: "response",
    channel: "model",
    id: "call-1",
    op: "model.stream",
    ok: true,
    result: { accepted: true },
  })
  release()
  try {
    await Promise.all([first, second, terminal])
    expect(delivered.map((message) => message.kind)).toEqual(["model.event", "model.event", "response"])
    decoder.finish()
  } finally {
    writer.close()
  }
})

test("writer limits queued work under a stalled sink and rejects all writes on sink failure", async () => {
  let release!: () => void
  const writer = new RemoteWriter(
    () =>
      new Promise<void>((_resolve, reject) => {
        release = () => reject(new Error("sink closed"))
      }),
  )
  const writes = Array.from({ length: REMOTE_LIMITS.queuedFrames }, (_, i) =>
    writer.send({ v: 1, kind: "ping", id: `p${i}` }).catch((error) => error.message),
  )
  await expect(writer.send({ v: 1, kind: "ping", id: "overflow" })).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  release()
  expect(await Promise.all(writes)).toEqual(Array(REMOTE_LIMITS.queuedFrames).fill("sink closed"))
})
