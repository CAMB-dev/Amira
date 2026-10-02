import { expect, test } from "bun:test"
import { closeTrace } from "../src/session/trace-shutdown.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("host shutdown drains emitted events before closing its recorder", async () => {
  const drained = deferred()
  const calls: string[] = []
  const done = closeTrace(
    {
      flush: () => {
        calls.push("drain")
        return drained.promise
      },
    },
    { close: async () => void calls.push("close") },
  )
  expect(calls).toEqual(["drain"])
  drained.resolve()
  await done
  expect(calls).toEqual(["drain", "close"])
})

test("a stuck subscriber does not prevent recorder close", async () => {
  let closed = false
  await closeTrace(
    { flush: () => new Promise(() => {}) },
    {
      close: async () => {
        closed = true
      },
    },
    5,
  )
  expect(closed).toBe(true)
})

test("a stuck recorder does not hold host shutdown forever", async () => {
  let closing = false
  await closeTrace(
    { flush: async () => {} },
    {
      close: () => {
        closing = true
        return new Promise(() => {})
      },
    },
    5,
  )
  expect(closing).toBe(true)
})

test("trace shutdown failures cannot replace the session exit code", async () => {
  await expect(
    closeTrace(
      { flush: async () => {} },
      {
        close: async () => {
          throw new Error("unwritable trace")
        },
      },
    ),
  ).resolves.toBeUndefined()
})

test("lightweight sessions without a recorder do not drain the bus", async () => {
  let drained = false
  await closeTrace(
    {
      flush: async () => {
        drained = true
      },
    },
    undefined,
  )
  expect(drained).toBe(false)
})
