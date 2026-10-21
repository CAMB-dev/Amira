import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createRemoteAgentPort } from "../../src/remote/agent-port.ts"
import { encodeRemoteMessage } from "../../src/remote/codec.ts"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { RemoteReplyError } from "../../src/remote/errors.ts"
import { classifyReconnectFailure } from "../../src/remote/reconnect-failure.ts"
import { observeSshRelay } from "../../src/remote/relay-io.ts"
import type { SshSession } from "../../src/remote/ssh.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"
import { hello, welcome } from "./loopback.ts"

function session(code?: number, bytes?: Uint8Array[], pendingOutput = false) {
  const output = Promise.withResolvers<void>()
  const drained = Promise.withResolvers<number>()
  let closes = 0
  const io: SshSession = {
    input: {
      async *[Symbol.asyncIterator]() {
        for (const part of bytes ?? []) yield part
        if (pendingOutput) await output.promise
      },
    },
    async write() {},
    async end() {},
    close() {
      closes++
      output.resolve()
      drained.resolve(code ?? 0)
    },
    exitStatus: code === undefined ? undefined : Promise.resolve(code),
    exited: drained.promise,
    stderr: () => `${"x".repeat(100000)}\x1b]2;bad-title\x07Remote account policy refuses attach\x1b[0m`,
  }
  const relay = observeSshRelay(io, { exitGraceMs: 5 })
  return { relay, io, drained, closes: () => closes }
}

test("bounded stderr drain preserves proven process status even when a pipe outlives the process", async () => {
  const f = session(1)
  const connection = new RemoteConnection(f.relay, { handshake: { role: "client", hello } })
  try {
    const error = await connection.ready.catch((error: unknown) => error)
    expect(classifyReconnectFailure(error)).toMatchObject({ retryable: false, code: "setup_failed" })
    expect((error as Error).message).toContain("status 1")
    expect((error as Error).message).toContain("Remote account policy refuses attach")
    expect((error as Error).message.length).toBeLessThanOrEqual(1024)
    expect((error as Error).message).not.toContain("\x1b")
    expect((error as Error).message).not.toContain("\x07")
    expect(f.closes()).toBe(1)
    expect(observeSshRelay(f.relay)).toBe(f.relay)
  } finally {
    connection.close()
    f.io.close()
    await f.drained.promise
  }
})

test("an EOF without termination proof is bounded and remains a recoverable transport interruption", async () => {
  const f = session()
  const connection = new RemoteConnection(f.relay, { handshake: { role: "client", hello } })
  try {
    expect(classifyReconnectFailure(await connection.ready.catch((error: unknown) => error)).retryable).toBe(
      true,
    )
    expect(f.closes()).toBe(1)
  } finally {
    connection.close()
    f.io.close()
    await f.drained.promise
  }
})

test("an intentional close retains its original cause and cancels pending exit reconciliation", async () => {
  const f = session(1)
  const connection = new RemoteConnection(f.relay, { handshake: { role: "client", hello } })
  const original = new RemoteReplyError("cancelled", "Intentional detach")
  connection.close(original)
  f.relay.close()
  expect(await connection.ready.catch((error: unknown) => error)).toBe(original)
  expect(connection.failureReason).toBe(original)
  expect(f.closes()).toBe(1)
  await f.drained.promise
})

test("a validated protocol rejection wins over the SSH relay's separate failure status", async () => {
  const f = session(1, [
    ...encodeRemoteMessage({
      v: 1,
      kind: "reject",
      error: { code: "permission_denied", message: "Protocol denied attach" },
    }),
  ])
  const connection = new RemoteConnection(f.relay, { handshake: { role: "client", hello } })
  const error = await connection.ready.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(RemoteReplyError)
  expect(classifyReconnectFailure(error)).toMatchObject({
    code: "permission_denied",
    retryable: false,
    message: "Protocol denied attach",
  })
  expect(connection.failureReason).toBe(error)
  await f.drained.promise
})

for (const malformed of [false, true])
  test(`a fresh snapshot wait preserves its terminal cause after welcome; malformed=${malformed}`, async () => {
    const bytes = [...encodeRemoteMessage(welcome)]
    if (malformed) bytes.push(new TextEncoder().encode("{malformed}\n"))
    const f = session(1, bytes)
    try {
      const error = await createRemoteAgentPort({ hello, connect: async () => f.relay }).catch(
        (error: unknown) => error,
      )
      expect(classifyReconnectFailure(error)).toMatchObject({
        code: malformed ? "invalid_frame" : "setup_failed",
        retryable: false,
      })
    } finally {
      f.relay.close()
      await f.drained.promise
    }
  })

test("proven process exit interrupts a pending inherited stdout read without waiting for a handshake timeout", async () => {
  const f = session(1, undefined, true)
  const connection = new RemoteConnection(f.relay, { handshake: { role: "client", hello } })
  try {
    const error = await connection.ready.catch((error: unknown) => error)
    expect(classifyReconnectFailure(error)).toMatchObject({ code: "setup_failed", retryable: false })
    expect((error as Error).message).toContain("status 1")
    expect(f.closes()).toBe(1)
  } finally {
    connection.close()
    f.relay.close()
    await f.drained.promise
  }
})

test("a proven relay exit disconnects an already-snapshotted port even while stdout remains pending", async () => {
  const terminated = Promise.withResolvers<number>()
  const drained = Promise.withResolvers<number>()
  let closes = 0
  const f = await agentPortFixture(
    {},
    {
      brokerPeer: {
        connect(io, greeting, onMessage, validateWelcome) {
          const relay = observeSshRelay(
            {
              ...io,
              end: async () => {},
              exitStatus: terminated.promise,
              exited: drained.promise,
              stderr: () => "Remote account policy stopped the relay",
              close() {
                closes++
                io.close()
                drained.resolve(1)
              },
            },
            { exitGraceMs: 5 },
          )
          return new RemoteConnection(relay, {
            handshake: { role: "client", hello: greeting, validateWelcome },
            onMessage,
          })
        },
      },
    },
  )
  try {
    expect(f.port.connection).toBe("connected")
    terminated.resolve(1)
    await until(() => f.port.connection === "disconnected")
    expect(classifyReconnectFailure(f.port.disconnectionReason)).toMatchObject({
      code: "setup_failed",
      retryable: false,
    })
    expect(closes).toBe(1)
  } finally {
    await f.close()
    await drained.promise
  }
})
