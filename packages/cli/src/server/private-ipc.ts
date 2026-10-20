import type { RemoteIO } from "../remote/connection.ts"
import { RemoteError } from "../remote/errors.ts"

/** The private Unix-socket prelude is not part of the public attach wire protocol. */
export async function readPrivatePrelude(
  io: RemoteIO,
  limit = 1024,
): Promise<{ value: unknown; tail: RemoteIO }> {
  const iterator = io.input[Symbol.asyncIterator]()
  let bytes = Buffer.alloc(0)
  const timer = setTimeout(() => io.close(), 5000)
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) throw new RemoteError("disconnected", "Private daemon connection ended before readiness")
      const chunk = Buffer.from(next.value)
      const end = chunk.indexOf(10)
      const header = end < 0 ? chunk : chunk.subarray(0, end)
      if (bytes.length + header.length > limit) throw new Error("Private daemon prelude is too large")
      bytes = Buffer.concat([bytes, header])
      if (end < 0) continue
      const remaining = chunk.subarray(end + 1)
      return {
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        tail: {
          ...io,
          input: {
            async *[Symbol.asyncIterator]() {
              try {
                if (remaining.length) yield remaining
                while (true) {
                  const part = await iterator.next()
                  if (part.done) return
                  yield part.value
                }
              } finally {
                await iterator.return?.()
              }
            },
          },
        },
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

export function privateMessage(io: RemoteIO, value: unknown): Promise<void> {
  return io.write(Buffer.from(`${JSON.stringify(value)}\n`))
}
