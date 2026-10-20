import "./offline.ts"
import { expect, test } from "bun:test"
import { createAi, emptyUsage, type ModelRequest, type StreamEvent } from "@amira/ai"
import { trackRuntimeAi } from "../../src/server/activity.ts"
import { proxyFixture } from "../remote/model-proxy-fixture.ts"

const event: StreamEvent = { type: "text.delta", text: "working" }
const yielded: IteratorResult<StreamEvent> = { done: false, value: event }
const done: IteratorResult<StreamEvent> = { done: true, value: undefined }

function activityFixture(iterator: AsyncIterator<StreamEvent>) {
  const source = createAi({
    providers: [{ id: "p", dialect: "mock", baseUrl: "https://provider.invalid" }],
    env: {},
  })
  source.stream = () => ({ [Symbol.asyncIterator]: () => iterator })
  const changes: number[] = []
  const activity = trackRuntimeAi(source, () => changes.push(activity.pending()))
  const request: ModelRequest = {
    model: source.model("p/m"),
    systemPrompt: "",
    messages: [],
    tools: [],
  }
  return { ...activity, source, changes, request }
}

for (const tracked of [false, true]) {
  test(`${tracked ? "tracked" : "bare"} proxy return cancels a pending next with reconnect timeout zero`, async () => {
    const fixture = proxyFixture(async function* () {}, 0)
    const activity = trackRuntimeAi(fixture.proxy)
    const ai = tracked ? activity.ai : fixture.proxy
    const iterator = ai.stream(fixture.request)[Symbol.asyncIterator]()
    const next = iterator.next()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.resolve()
      expect(activity.pending()).toBe(tracked ? 1 : 0)
      const returned = iterator.return!()
      const outcome = await Promise.race([
        returned.then(() => "returned"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still pending"), 100)
        }),
      ])
      expect(outcome).toBe("returned")
      expect(activity.pending()).toBe(0)
      await next
    } finally {
      clearTimeout(timer)
      fixture.close()
      await next
    }
  })
}

test("stream activity starts lazily, forwards receivers and arguments, and stops on done once", async () => {
  let calls = 0
  const iterator: AsyncIterator<StreamEvent> = {
    async next(value) {
      expect(this).toBe(iterator)
      expect(value).toBe(calls++ === 0 ? "first" : "last")
      return calls === 1 ? yielded : done
    },
  }
  const fixture = activityFixture(iterator)
  const signal = new AbortController().signal
  fixture.source.stream = function (request, receivedSignal) {
    expect(this).toBe(fixture.source)
    expect(request).toBe(fixture.request)
    expect(receivedSignal).toBe(signal)
    const source = {
      [Symbol.asyncIterator]() {
        expect(this).toBe(source)
        return iterator
      },
    }
    return source
  }
  const tracked = fixture.ai.stream(fixture.request, signal)[Symbol.asyncIterator]()
  expect(fixture.pending()).toBe(0)
  expect(fixture.changes).toEqual([])
  expect(await tracked.next("first")).toBe(yielded)
  expect(fixture.changes).toEqual([1])
  expect(await tracked.next("last")).toBe(done)
  await tracked.return?.()
  await tracked.return?.()
  expect(fixture.pending()).toBe(0)
  expect(fixture.changes).toEqual([1, 0])
})

for (const synchronous of [false, true]) {
  test(`${synchronous ? "synchronous" : "rejected"} next errors finish activity exactly once`, async () => {
    const error = new Error("next failed")
    const fixture = activityFixture({
      next() {
        if (synchronous) throw error
        return Promise.reject(error)
      },
    })
    const iterator = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBe(error)
    await iterator.return?.()
    expect(fixture.pending()).toBe(0)
    expect(fixture.changes).toEqual([1, 0])
  })
}

test("concurrent next and repeated returns forward immediately without restarting activity", async () => {
  const waiting = Promise.withResolvers<IteratorResult<StreamEvent>>()
  const closing = Promise.withResolvers<IteratorResult<StreamEvent>>()
  const calls: string[] = []
  const iterator: AsyncIterator<StreamEvent> = {
    next(value) {
      expect(this).toBe(iterator)
      calls.push(`next:${value}`)
      return waiting.promise
    },
    return(value) {
      expect(this).toBe(iterator)
      calls.push(`return:${value}`)
      return closing.promise
    },
  }
  const fixture = activityFixture(iterator)
  const tracked = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
  const first = tracked.next("a")
  const second = tracked.next("b")
  const returned = tracked.return!("c")
  const repeated = tracked.return!("d")
  expect(calls).toEqual(["next:a", "next:b", "return:c", "return:d"])
  expect(fixture.changes).toEqual([1])
  closing.resolve(done)
  await Promise.all([returned, repeated])
  expect(fixture.changes).toEqual([1, 0])
  waiting.resolve(yielded)
  expect(await first).toBe(yielded)
  expect(await second).toBe(yielded)
  await tracked.return!("e")
  expect(fixture.changes).toEqual([1, 0])
})

test("throw forwards immediately with its receiver while next is pending", async () => {
  const waiting = Promise.withResolvers<IteratorResult<StreamEvent>>()
  const error = new Error("cancel")
  let thrown = false
  const iterator: AsyncIterator<StreamEvent> = {
    next: () => waiting.promise,
    throw(received) {
      expect(this).toBe(iterator)
      expect(received).toBe(error)
      thrown = true
      return Promise.reject(error)
    },
  }
  const fixture = activityFixture(iterator)
  const tracked = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
  const next = tracked.next()
  const rejected = tracked.throw!(error)
  expect(thrown).toBe(true)
  await expect(rejected).rejects.toBe(error)
  waiting.resolve(done)
  await next
  await tracked.return?.()
  expect(fixture.changes).toEqual([1, 0])
})

test("handled throw and nonterminal return keep activity until the iterator really finishes", async () => {
  const fixture = activityFixture({
    next: async () => yielded,
    throw: async () => yielded,
    return: async (value) => (value === "finish" ? done : yielded),
  })
  const iterator = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
  await iterator.next()
  expect(await iterator.throw!(new Error("handled"))).toBe(yielded)
  expect(await iterator.return!("continue")).toBe(yielded)
  expect(fixture.pending()).toBe(1)
  expect(fixture.changes).toEqual([1])
  expect(await iterator.return!("finish")).toBe(done)
  expect(fixture.changes).toEqual([1, 0])
})

test("missing return supplies a terminal result without leaking or double counting", async () => {
  const fixture = activityFixture({ next: async () => yielded })
  const iterator = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
  await iterator.next()
  expect(await iterator.return!("finished")).toEqual({ done: true, value: "finished" })
  await iterator.return!()
  expect(fixture.pending()).toBe(0)
  expect(fixture.changes).toEqual([1, 0])
})

for (const hasReturn of [false, true]) {
  test(`missing throw ${hasReturn ? "closes the source then" : "without return"} rejects and finishes once`, async () => {
    let closed = false
    const source: AsyncIterator<StreamEvent> = {
      next: async () => yielded,
      ...(hasReturn
        ? {
            async return() {
              expect(this).toBe(source)
              closed = true
              return done
            },
          }
        : {}),
    }
    const fixture = activityFixture(source)
    const iterator = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
    await iterator.next()
    await expect(iterator.throw!(new Error("unhandled"))).rejects.toBeInstanceOf(TypeError)
    expect(closed).toBe(hasReturn)
    await iterator.return!()
    expect(fixture.changes).toEqual([1, 0])
  })
}

for (const method of ["return", "throw"] as const) {
  for (const synchronous of [false, true]) {
    test(`${method} ${synchronous ? "throws synchronously" : "rejects"} without leaking activity`, async () => {
      const error = new Error("cleanup failed")
      const fixture = activityFixture({
        next: async () => yielded,
        [method]() {
          if (synchronous) throw error
          return Promise.reject(error)
        },
      })
      const iterator = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
      await iterator.next()
      await expect(iterator[method]!(error)).rejects.toBe(error)
      await expect(iterator[method]!(error)).rejects.toBe(error)
      expect(fixture.pending()).toBe(0)
      expect(fixture.changes).toEqual([1, 0])
    })
  }
}

test("return before next and repeated terminal operations never start activity", async () => {
  const fixture = activityFixture({ next: async () => done })
  const iterator = fixture.ai.stream(fixture.request)[Symbol.asyncIterator]()
  await iterator.return!()
  await iterator.return!()
  await iterator.next()
  expect(fixture.pending()).toBe(0)
  expect(fixture.changes).toEqual([])
})

test("independent streams and compact operations share the live activity count", async () => {
  const fixture = activityFixture({ next: async () => yielded })
  const result = Promise.withResolvers<Awaited<ReturnType<typeof fixture.source.compact>>>()
  const signal = new AbortController().signal
  const progress = () => {}
  const usage = () => {}
  fixture.source.compact = function (...args) {
    expect(this).toBe(fixture.source)
    expect(args).toEqual([fixture.request, signal, progress, usage])
    return result.promise
  }
  const stream = fixture.ai.stream(fixture.request)
  const first = stream[Symbol.asyncIterator]()
  const second = stream[Symbol.asyncIterator]()
  await first.next()
  await second.next()
  const compact = fixture.ai.compact(fixture.request, signal, progress, usage)
  expect(fixture.pending()).toBe(3)
  await first.return!()
  result.resolve({ ok: false, error: "not supported", tried: [], usage: emptyUsage() })
  await compact
  await second.return!()
  expect(fixture.pending()).toBe(0)
  expect(fixture.changes).toEqual([1, 2, 3, 2, 1, 0])
})

test("compact rejection finishes activity and model lookup remains dynamically forwarded", async () => {
  const fixture = activityFixture({ next: async () => done })
  const first = fixture.request.model
  const second = { ...first, id: "updated" }
  let model = first
  Object.defineProperty(fixture.source, "model", {
    get() {
      expect(this).toBe(fixture.source)
      return () => model
    },
  })
  expect(fixture.ai.model("p/m")).toBe(first)
  model = second
  expect(fixture.ai.model("p/m")).toBe(second)
  const error = new Error("compact failed")
  fixture.source.compact = () => Promise.reject(error)
  await expect(fixture.ai.compact(fixture.request)).rejects.toBe(error)
  expect(fixture.changes).toEqual([1, 0])
})
