import { expect, test } from "bun:test"
import type { RemoteIO } from "../../src/remote/connection.ts"
import { RemoteError } from "../../src/remote/errors.ts"
import { PreludeTimeoutError, readPrivatePrelude } from "../../src/server/private-ipc.ts"

/** A socket that accepts but never answers; closing it leaves the pending read hanging. */
function silentSocket() {
  let closed = false
  const io: RemoteIO = {
    input: {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
    },
    async write() {},
    close() {
      closed = true
    },
  }
  return { io, closed: () => closed }
}

test("a slow daemon's readiness reply times out as a retryable disconnect", async () => {
  const socket = silentSocket()
  const error = await readPrivatePrelude(socket.io, 1024, { ms: 20 }).catch((e: unknown) => e)
  // Readiness probes retry only RemoteError("disconnected") until the startup deadline.
  expect(error).toBeInstanceOf(RemoteError)
  expect((error as RemoteError).code).toBe("disconnected")
  expect(socket.closed()).toBe(true)
})

test("close: false times out with PreludeTimeoutError and leaves the input open", async () => {
  const socket = silentSocket()
  const error = await readPrivatePrelude(socket.io, 1024, { ms: 20, close: false }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PreludeTimeoutError)
  expect(socket.closed()).toBe(false)
})
