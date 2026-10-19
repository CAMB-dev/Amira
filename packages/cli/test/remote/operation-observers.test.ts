import { expect, spyOn, test } from "bun:test"
import { REMOTE_LIMITS } from "../../src/remote/protocol.ts"
import { OperationObservers } from "../../src/server/operation-observers.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

test("retries install one settlement observer and remove disconnected transport waiters", async () => {
  const source = deferred<string>()
  const then = spyOn(source.promise, "then")
  const observers = new OperationObservers()
  try {
    for (let i = 0; i < 300; i++) {
      const abort = new AbortController()
      const waiter = observers.wait(source.promise, abort.signal).catch((error) => error)
      abort.abort()
      expect(await waiter).toMatchObject({ code: "cancelled" })
    }
    expect(then).toHaveBeenCalledTimes(1)
    const current = observers.wait(source.promise, new AbortController().signal)
    source.resolve("completed")
    expect(await current).toBe("completed")
    expect(await observers.wait(source.promise, new AbortController().signal)).toBe("completed")
    expect(then).toHaveBeenCalledTimes(1)
  } finally {
    then.mockRestore()
  }
})

test("simultaneous transport observers are bounded and aborted waiters release capacity", async () => {
  const source = deferred<number>()
  const observers = new OperationObservers()
  const controllers = Array.from({ length: REMOTE_LIMITS.pendingRequests }, () => new AbortController())
  const waiters = controllers.map((abort) =>
    observers.wait(source.promise, abort.signal).catch((error) => error),
  )
  await expect(observers.wait(source.promise, new AbortController().signal)).rejects.toMatchObject({
    code: "limit_exceeded",
  })
  for (const abort of controllers) abort.abort()
  await Promise.all(waiters)
  const current = observers.wait(source.promise, new AbortController().signal)
  source.resolve(7)
  expect(await current).toBe(7)
})

test("terminal failures are observed even when every transport has disconnected", async () => {
  const source = deferred<string>()
  const observers = new OperationObservers()
  const abort = new AbortController()
  const waiter = observers.wait(source.promise, abort.signal).catch((error) => error)
  abort.abort()
  await waiter
  const failure = new Error("retained failure")
  source.reject(failure)
  await Bun.sleep(0)
  await expect(observers.wait(source.promise, new AbortController().signal)).rejects.toBe(failure)
})
