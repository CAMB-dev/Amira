import "../server/offline.ts"
import { expect, test } from "bun:test"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { RemoteError, RemoteReplyError } from "../../src/remote/errors.ts"
import { hello, loopback, welcome } from "./loopback.ts"

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`)

test("handshake preserves Linux workspace paths, versions, generations, capabilities and limits", async () => {
  const io = loopback(1)
  const server = new RemoteConnection(io.server, {
    handshake: {
      role: "server",
      accept: (received) => {
        expect(received).toEqual(hello)
        return welcome
      },
    },
  })
  const client = new RemoteConnection(io.client, { handshake: { role: "client", hello } })
  try {
    expect(await client.ready).toEqual(welcome)
    expect(await server.ready).toEqual(welcome)
  } finally {
    client.close()
    server.close()
  }
})

test("handshake sends the capability descriptor snapshot, not a proxy toJSON replacement", async () => {
  const io = loopback(7)
  let gets = 0
  let received: unknown
  const capabilities = new Proxy(["model.proxy"], {
    get(target, key, receiver) {
      gets++
      return key === "toJSON" ? () => ["replacement"] : Reflect.get(target, key, receiver)
    },
  })
  const server = new RemoteConnection(io.server, {
    handshake: {
      role: "server",
      accept(value) {
        received = value
        return welcome
      },
    },
  })
  const client = new RemoteConnection(io.client, {
    handshake: { role: "client", hello: { ...hello, capabilities } },
  })
  try {
    await Promise.all([client.ready, server.ready])
    expect(received).toEqual(hello)
    expect(gets).toBe(0)
  } finally {
    client.close()
    server.close()
  }
})

test("incompatible version fails before accepting a workspace or executing operations", async () => {
  const io = loopback()
  let accepted = false
  const server = new RemoteConnection(io.server, {
    handshake: {
      role: "server",
      accept: () => {
        accepted = true
        return welcome
      },
    },
  })
  const rejected = server.ready.catch((error) => error)
  io.injectServer(encode({ ...hello, v: 2 }))
  expect(await rejected).toMatchObject({ code: "incompatible_protocol" })
  await server.closed
  expect(accepted).toBe(false)
})

test("operations before hello, repeated hello and incomplete EOF are rejected", async () => {
  for (const initial of [encode({ v: 1, kind: "ping", id: "p1" }), new TextEncoder().encode('{"v":1')]) {
    const io = loopback()
    const server = new RemoteConnection(io.server, { handshake: { role: "server", accept: () => welcome } })
    const rejected = server.ready.catch((error) => error)
    io.injectServer(initial)
    io.client.close()
    expect(await rejected).toMatchObject({ code: "invalid_frame" })
    await server.closed
  }
  const io = loopback()
  const server = new RemoteConnection(io.server, { handshake: { role: "server", accept: () => welcome } })
  io.injectServer(encode(hello))
  await server.ready
  io.injectServer(encode(hello))
  await server.closed
})

test("handshake rejection preserves controller contention rather than reporting a version mismatch", async () => {
  const io = loopback()
  const client = new RemoteConnection(io.client, { handshake: { role: "client", hello } })
  const rejection = client.ready.catch((error) => error)
  await io.server.write(encode({ v: 1, kind: "reject", error: { code: "controller_busy", message: "Busy" } }))
  expect(await rejection).toMatchObject({ code: "controller_busy", message: "Busy" })
  await client.closed
})

for (const [label, error, code] of [
  [
    "controller contention",
    new RemoteReplyError("controller_busy", "SENTINEL_URL_PASSWORD"),
    "controller_busy",
  ],
  ["transport limit", new RemoteError("limit_exceeded", "SENTINEL_URL_PASSWORD"), "limit_exceeded"],
  ["unknown exception", new Error("SENTINEL_URL_PASSWORD"), "operation_failed"],
  ["invalid code", new RemoteReplyError("invalid code", "SENTINEL_URL_PASSWORD"), "operation_failed"],
  ["unregistered code", new RemoteReplyError("unknown_failure", "SENTINEL_URL_PASSWORD"), "operation_failed"],
  ["untyped error facts", { code: "controller_busy", message: "SENTINEL_URL_PASSWORD" }, "operation_failed"],
] as const) {
  test(`server accept refusal sends a sanitised reject before closing: ${label}`, async () => {
    const io = loopback(13)
    const output: string[] = []
    const server = new RemoteConnection(
      {
        ...io.server,
        async write(bytes) {
          output.push(new TextDecoder().decode(bytes))
          await io.server.write(bytes)
        },
      },
      {
        handshake: {
          role: "server",
          async accept() {
            await Promise.resolve()
            throw error
          },
        },
      },
    )
    const client = new RemoteConnection(io.client, { handshake: { role: "client", hello } })
    const local = server.ready.catch((failure) => failure)
    const remote = client.ready.catch((failure) => failure)
    try {
      expect(await remote).toMatchObject({ code })
      expect(await local).toMatchObject({ code })
      await Promise.all([client.closed, server.closed])
      expect(output).toHaveLength(1)
      expect(JSON.parse(output.join(""))).toMatchObject({ v: 1, kind: "reject", error: { code } })
      expect(output.join("")).not.toContain("SENTINEL")
    } finally {
      client.close()
      server.close()
    }
  })
}

test("stalled handshake is bounded and close is idempotent", async () => {
  const io = loopback()
  const client = new RemoteConnection(io.client, {
    handshake: { role: "client", hello },
    handshakeTimeoutMs: 10,
  })
  await expect(client.ready).rejects.toThrow("timed out")
  await client.closed
  client.close()
})
