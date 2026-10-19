import "../server/offline.ts"
import { expect, test } from "bun:test"
import { RemoteConnection, type RemoteConnectionOptions } from "../../src/remote/connection.ts"
import { REMOTE_LIMITS } from "../../src/remote/protocol.ts"
import { hello, loopback, welcome } from "./loopback.ts"
import { state } from "./schema-fixtures.ts"

const wire = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`)
const request = (id: string) => ({
  v: 1,
  kind: "request",
  channel: "control",
  id,
  sessionGeneration: 1,
  controllerGeneration: 1,
  op: "state.read",
  params: {},
})
async function rawServer(handle: RemoteConnectionOptions["handle"]) {
  const io = loopback()
  const server = new RemoteConnection(io.server, {
    handshake: { role: "server", accept: () => welcome },
    handle,
  })
  io.injectServer(wire(hello))
  await server.ready
  return { io, server }
}

test("incoming concurrent handlers are independently bounded and cancelled on protocol failure", async () => {
  let calls = 0
  let aborted = 0
  const { io, server } = await rawServer(async (_request, signal) => {
    calls++
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted++
          resolve()
        },
        { once: true },
      ),
    )
    return state
  })
  try {
    for (let i = 0; i <= REMOTE_LIMITS.pendingRequests; i++) io.injectServer(wire(request(`r${i}`)))
    await server.closed
    expect(calls).toBe(REMOTE_LIMITS.pendingRequests)
    expect(aborted).toBe(calls)
  } finally {
    server.close()
  }
})

test("duplicate in-flight IDs, incorrect operation channels and incorrect cancel channels fail closed", async () => {
  for (const invalid of [
    request("r1"),
    { ...request("r2"), channel: "model" },
    { v: 1, kind: "cancel", id: "r1", channel: "model" },
  ]) {
    let started!: () => void
    let aborted = false
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    const { io, server } = await rawServer(async (_request, signal) => {
      started()
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
      return state
    })
    try {
      io.injectServer(wire(request("r1")))
      await start
      io.injectServer(wire(invalid))
      await server.closed
      expect(aborted).toBe(true)
    } finally {
      server.close()
    }
  }
})

test("closing during a decoded batch prevents admission of the remaining requests", async () => {
  const io = loopback()
  let calls = 0
  const server = new RemoteConnection(io.server, {
    handshake: { role: "server", accept: () => welcome },
    onMessage: () => server.close(),
    handle: async () => {
      calls++
      return state
    },
  })
  try {
    io.injectServer(wire(hello))
    await server.ready
    io.injectServer(
      new TextEncoder().encode(
        `${JSON.stringify({ v: 1, kind: "event", daemonEpoch: "epoch-1", seq: 1, payload: { seq: 1, ts: 1, sessionId: "s1", type: "ui.render", data: {} } })}\n${JSON.stringify(request("r1"))}\n`,
      ),
    )
    await server.closed
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(0)
  } finally {
    server.close()
  }
})

test("malformed operation params are rejected before any incoming handler runs", async () => {
  for (const invalid of [
    { op: "turn.prompt", params: {} },
    { op: "thinking.set", params: { level: "not-an-effort" } },
    { op: "fastMode.set", params: { enabled: "false", extra: "unexpected" } },
  ]) {
    let calls = 0
    const { io, server } = await rawServer(async () => {
      calls++
      return state
    })
    try {
      io.injectServer(wire({ ...request("r1"), ...invalid }))
      await server.closed
      expect(calls).toBe(0)
    } finally {
      server.close()
    }
  }
})

test("a mismatched response operation cannot settle a correlated operation", async () => {
  const io = loopback()
  const client = new RemoteConnection(io.client, { handshake: { role: "client", hello } })
  try {
    await io.server.write(wire(welcome))
    await client.ready
    const result = client.request("state.read", {}, { operationId: "r1" }).catch((error) => error)
    await io.server.write(
      wire({
        v: 1,
        kind: "response",
        channel: "control",
        id: "r1",
        op: "turn.abort",
        ok: true,
        result: { sessionGeneration: 1 },
      }),
    )
    expect(await result).toMatchObject({ code: "invalid_frame", message: "Response operation mismatch" })
    await client.closed
  } finally {
    client.close()
  }
})

test("a malformed result for the correct operation cannot settle a correlated operation", async () => {
  const io = loopback()
  const client = new RemoteConnection(io.client, { handshake: { role: "client", hello } })
  try {
    await io.server.write(wire(welcome))
    await client.ready
    const result = client.request("state.read", {}, { operationId: "r1" }).catch((error) => error)
    await io.server.write(
      wire({
        v: 1,
        kind: "response",
        channel: "control",
        id: "r1",
        op: "state.read",
        ok: true,
        result: { ...state, status: "invalid" },
      }),
    )
    expect(await result).toMatchObject({ code: "invalid_frame" })
    await client.closed
  } finally {
    client.close()
  }
})

test("a mismatched response channel cannot settle a correlated operation", async () => {
  const io = loopback()
  const client = new RemoteConnection(io.client, { handshake: { role: "client", hello } })
  try {
    await io.server.write(wire(welcome))
    await client.ready
    const result = client.request("state.read", {}, { operationId: "r1" }).catch((error) => error)
    await io.server.write(
      wire({ v: 1, kind: "response", channel: "model", id: "r1", op: "state.read", ok: true, result: state }),
    )
    expect(await result).toMatchObject({ code: "invalid_frame", message: "Response channel mismatch" })
    await client.closed
  } finally {
    client.close()
  }
})

test("completed inbound request identities cannot be reused to change cancellation context", async () => {
  let calls = 0
  const { io, server } = await rawServer(async () => {
    calls++
    return state
  })
  const output = io.client.input[Symbol.asyncIterator]()
  try {
    await output.next() // welcome
    io.injectServer(wire(request("completed-id")))
    await output.next() // completed response
    io.injectServer(wire({ ...request("completed-id"), op: "turn.abort" }))
    await server.closed
    expect(calls).toBe(1)
    await expect(server.request("state.read", {})).rejects.toMatchObject({ code: "invalid_frame" })
  } finally {
    server.close()
    io.client.close()
    await output.return?.()
  }
})
