import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { StreamEvent } from "@amira/ai"
import { collectEvents, deferred, proxyFixture } from "./model-proxy-fixture.ts"

const done: StreamEvent = {
  type: "done",
  message: { role: "assistant", model: { provider: "p", model: "m" }, content: [], stopReason: "end" },
}

test("iterator return interrupts a pending next during admission without waiting for the reconnect timeout", async () => {
  const fixture = proxyFixture(async function* () {
    yield done
  }, 60_000)
  try {
    const iterator = fixture.proxy.stream(fixture.request)[Symbol.asyncIterator]()
    const next = iterator.next()
    await iterator.return?.()
    expect((await next).value).toMatchObject({ type: "error", message: { stopReason: "aborted" } })
  } finally {
    fixture.close()
  }
})

test("iterator return interrupts pending accepted HTTP work and does not close the shared connection", async () => {
  const started = deferred()
  const aborted = deferred()
  const fixture = proxyFixture(async function* (request, context) {
    if (request.systemPrompt === "other") {
      yield done
      return
    }
    context.signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
    started.resolve()
    await aborted.promise
    yield done
  }, 60_000)
  try {
    const connection = await fixture.connect()
    const iterator = fixture.proxy.stream(fixture.request)[Symbol.asyncIterator]()
    const next = iterator.next()
    await started.promise
    await iterator.return?.()
    await next
    await aborted.promise
    const other = await collectEvents(fixture.proxy.stream({ ...fixture.request, systemPrompt: "other" }))
    expect(other.at(-1)?.type).toBe("done")
    await connection.send({ v: 1, kind: "ping", id: "still-alive" })
  } finally {
    fixture.close()
  }
})

test("cancelling a delayed open acknowledgement maps the request ID without disconnecting other calls", async () => {
  const response = deferred()
  const blocked = deferred()
  const started = deferred()
  const aborted = deferred()
  const fixture = proxyFixture(async function* (request, context) {
    if (request.systemPrompt === "other") {
      yield done
      return
    }
    context.signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
    started.resolve()
    await aborted.promise
    yield done
  })
  try {
    await fixture.connect(false, {
      async localWrite(bytes) {
        const frame = JSON.parse(Buffer.from(bytes).toString())
        if (frame.kind === "response" && frame.op === "model.open") {
          blocked.resolve()
          await response.promise
        }
      },
    })
    const controller = new AbortController()
    const work = collectEvents(fixture.proxy.stream(fixture.request, controller.signal))
    await started.promise
    await blocked.promise
    controller.abort()
    await work
    await aborted.promise
    response.resolve()
    const other = await collectEvents(fixture.proxy.stream({ ...fixture.request, systemPrompt: "other" }))
    expect(other.at(-1)?.type).toBe("done")
  } finally {
    response.resolve()
    fixture.close()
  }
})

test("an accepted cancellation while disconnected is delivered on the next authorized attachment", async () => {
  const started = deferred()
  const aborted = deferred()
  const fixture = proxyFixture(async function* (_request, context) {
    context.signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
    started.resolve()
    await aborted.promise
    yield done
  })
  try {
    const connection = await fixture.connect()
    const controller = new AbortController()
    const work = collectEvents(fixture.proxy.stream(fixture.request, controller.signal))
    await started.promise
    connection.close()
    await connection.closed
    controller.abort()
    await work
    await fixture.connect()
    await aborted.promise
  } finally {
    fixture.close()
  }
})

test("buffered event ACKs cannot overtake a chunked resume admission", async () => {
  const release = deferred()
  const chunk = deferred()
  const unblock = deferred()
  let attempts = 0
  const fixture = proxyFixture(async function* () {
    attempts++
    for (let i = 0; i < 3; i++) yield { type: "text.delta", text: `part ${i} `.repeat(30) }
    await release.promise
    yield done
  })
  fixture.request.systemPrompt = "x".repeat(300_000)
  try {
    const connection = await fixture.connect()
    const iterator = fixture.proxy.stream(fixture.request)[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done || next.value.type === "text.delta") break
    }
    connection.close()
    await connection.closed
    await fixture.connect(false, {
      async serverWrite(bytes) {
        const frame = JSON.parse(Buffer.from(bytes).toString())
        if (frame.kind === "chunk" && frame.index === 0) {
          chunk.resolve()
          await unblock.promise
        }
      },
    })
    await chunk.promise
    const before = fixture.sent.length
    const next = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.sent.slice(before).some((line) => JSON.parse(line).kind === "ack")).toBe(false)
    unblock.resolve()
    release.resolve()
    await next
    const rest = []
    while (true) {
      const event = await iterator.next()
      if (event.done) break
      rest.push(event.value)
    }
    expect(rest.at(-1)?.type).toBe("done")
    expect(attempts).toBe(1)
  } finally {
    release.resolve()
    unblock.resolve()
    fixture.close()
  }
})
