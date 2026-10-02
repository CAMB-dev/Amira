import { expect, jest, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { Dialect, DialectCompactOutcome, ProviderCompat } from "../src/dialect.ts"
import {
  CompactionFailures,
  FORGET_FAILURE_MS,
  isUnsupportedCompaction,
  type RememberedFailures,
} from "../src/native-compaction.ts"
import type { RetryOptions } from "../src/retry.ts"
import type { ModelRequest } from "../src/types.ts"

type Script = DialectCompactOutcome | ((signal: AbortSignal) => Promise<DialectCompactOutcome>)

/** A dialect whose compaction answers from a script, one outcome per call, and records calls. */
function fakeDialect(outcomes: Script[]) {
  const calls: { method: string; req: ModelRequest; signal: AbortSignal }[] = []
  const dialect: Dialect = {
    id: "fake",
    async *stream() {},
    compaction: {
      methods: ["first", "second"],
      layouts: ["tail", "recent-user"],
      midTurn: true,
      official: (baseUrl) => baseUrl.startsWith("https://official."),
      async compact(method, req, ctx) {
        calls.push({ method, req, signal: ctx.signal })
        const next = outcomes.shift()
        return typeof next === "function"
          ? next(ctx.signal)
          : (next ?? {
              ok: false,
              error: { message: "no script" },
              unsupported: false,
              retryable: false,
            })
      },
    },
  }
  return { dialect, calls }
}

const ok = (value = "CP"): DialectCompactOutcome => ({
  ok: true,
  value,
  usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
})
const unsupported = (message = "HTTP 404: not found"): DialectCompactOutcome => ({
  ok: false,
  error: { message, status: 404 },
  unsupported: true,
  retryable: false,
})

function setup(
  outcomes: Script[],
  baseUrl = "http://proxy.local/v1",
  compat?: ProviderCompat,
  retry: RetryOptions = { retries: 2, baseDelayMs: 1 },
) {
  const { dialect, calls } = fakeDialect(outcomes)
  const saved: RememberedFailures[] = []
  const ai = createAi({
    dialects: [dialect],
    retry,
    compactionMemory: { load: () => ({}), save: (f) => void saved.push(structuredClone(f)) },
    providers: [
      {
        id: "p",
        dialect: "fake",
        baseUrl,
        ...(compat ? { compat } : {}),
        defaultModel: { cost: { input: 2, output: 10 } },
      },
    ],
  })
  const req = (): ModelRequest => ({
    model: ai.model("p/m"),
    systemPrompt: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  })
  return { ai, calls, saved, req }
}

test("on by default only on the vendor's own endpoints; compat.compaction decides elsewhere", () => {
  const official = setup([], "https://official.example/v1")
  expect(official.ai.nativeCompaction(official.ai.model("p/m"))).toEqual({
    dialect: "fake",
    methods: ["first", "second"],
    layouts: ["tail", "recent-user"],
    midTurn: true,
  })
  const proxy = setup([], "http://proxy.local/v1")
  expect(proxy.ai.nativeCompaction(proxy.ai.model("p/m"))).toBeUndefined()
  const on = setup([], "http://proxy.local/v1", { compaction: "on" })
  expect(on.ai.nativeCompaction(on.ai.model("p/m"))?.methods).toEqual(["first", "second"])
  const off = setup([], "https://official.example/v1", { compaction: "off" })
  expect(off.ai.nativeCompaction(off.ai.model("p/m"))).toBeUndefined()
})

test("a checkpoint names the provider, host and model it came from, and its usage is priced", async () => {
  const { ai, req } = setup([ok()], "https://official.example/v1")
  const r = await ai.compact(req())
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.checkpoint).toEqual({
    dialect: "fake",
    value: "CP",
    kind: "checkpoint",
    provider: "p",
    host: "official.example",
    model: "m",
  })
  expect(r.method).toBe("first")
  // 1000 in at $2/M and 100 out at $10/M.
  expect(r.usage.cost).toBeCloseTo(0.003)
})

test("an unsupported way falls through to the next, and is skipped from then on", async () => {
  const { ai, calls, saved, req } = setup([unsupported(), ok(), ok()], "http://proxy.local", {
    compaction: "on",
  })
  const first = await ai.compact(req())
  expect(first.ok && first.method).toBe("second")
  expect(first.ok && first.tried).toEqual([
    { method: "first", error: "HTTP 404: not found", unsupported: true },
  ])
  expect(Object.keys(saved.at(-1)!)).toEqual(["p proxy.local m"])
  expect(ai.nativeCompaction(ai.model("p/m"))?.methods).toEqual(["second"])
  await ai.compact(req())
  expect(calls.map((c) => c.method)).toEqual(["first", "second", "second"])
})

test("when every way is unsupported, there is none left to offer", async () => {
  const { ai, req } = setup([unsupported(), unsupported("HTTP 501: /responses/compact not supported")], "x", {
    compaction: "on",
  })
  const r = await ai.compact(req())
  expect(r.ok).toBe(false)
  expect(!r.ok && r.error).toContain("501")
  expect(ai.nativeCompaction(ai.model("p/m"))).toBeUndefined()
})

test("transient failures are retried, then the next way is tried, and nothing is remembered", async () => {
  const busy: DialectCompactOutcome = {
    ok: false,
    error: { message: "HTTP 503", status: 503 },
    unsupported: false,
    retryable: true,
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const { ai, calls, saved, req } = setup([busy, busy, busy, ok()], "x", { compaction: "on" })
  const r = await ai.compact(req())
  expect(calls.map((c) => c.method)).toEqual(["first", "first", "first", "second"])
  expect(r.ok).toBe(true)
  // The failed attempts still count.
  expect(r.usage.input).toBe(1030)
  expect(saved).toEqual([])
  expect(ai.nativeCompaction(ai.model("p/m"))?.methods).toEqual(["first", "second"])
})

test("an abort stops trying", async () => {
  const { ai, calls, req } = setup([ok()], "x", { compaction: "on" })
  const abort = new AbortController()
  abort.abort()
  const r = await ai.compact(req(), abort.signal)
  expect(r).toMatchObject({ ok: false, aborted: true })
  expect(calls).toEqual([])
})

test("native compaction times out, aborts its request, and remains supported", async () => {
  const hang: Script = (signal) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(unsupported("aborted")), { once: true })
    })
  const { ai, calls, saved, req } = setup([hang, ok()], "https://official.example", undefined, {
    retries: 3,
    nativeCompactionTimeoutMs: 15,
  })
  const caller = new AbortController()
  expect(await ai.compact(req(), caller.signal)).toMatchObject({
    ok: false,
    timedOut: true,
    error: "native compaction timed out after 15 ms",
  })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.signal.aborted).toBe(true)
  expect(caller.signal.aborted).toBe(false)
  expect(saved).toEqual([])
  expect(ai.nativeCompaction(ai.model("p/m"))?.methods).toEqual(["first", "second"])
  expect((await ai.compact(req())).ok).toBe(true)
})

test("the default native deadline is five minutes; late outcomes cannot change its result", async () => {
  jest.useFakeTimers()
  try {
    const late = Promise.withResolvers<DialectCompactOutcome>()
    const { ai, calls, saved, req } = setup([() => late.promise], "https://official.example")
    let settled = false
    const done = ai.compact(req()).then((result) => {
      settled = true
      return result
    })
    jest.advanceTimersByTime(299_999)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(calls[0]!.signal.aborted).toBe(false)
    jest.advanceTimersByTime(1)
    const result = await done
    expect(result).toMatchObject({
      ok: false,
      timedOut: true,
      error: "native compaction timed out after 300000 ms",
      usage: { input: 0, output: 0 },
      tried: [],
    })
    expect(calls[0]!.signal.aborted).toBe(true)
    late.resolve({ ...unsupported(), usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 } })
    await Promise.resolve()
    await Promise.resolve()
    expect(result.usage.input).toBe(0)
    expect(result.tried).toEqual([])
    expect(saved).toEqual([])
  } finally {
    jest.useRealTimers()
  }
})

test("zero disables the native deadline, and success clears it and the caller's abort listener", async () => {
  jest.useFakeTimers()
  try {
    for (const nativeCompactionTimeoutMs of [0, 15]) {
      const finish = Promise.withResolvers<DialectCompactOutcome>()
      const { ai, calls, req } = setup([() => finish.promise], "https://official.example", undefined, {
        nativeCompactionTimeoutMs,
      })
      const caller = new AbortController()
      const done = ai.compact(req(), caller.signal)
      if (nativeCompactionTimeoutMs === 0) {
        jest.advanceTimersByTime(600_000)
        expect(calls[0]!.signal.aborted).toBe(false)
      }
      finish.resolve(ok())
      expect((await done).ok).toBe(true)
      jest.advanceTimersByTime(600_000)
      caller.abort()
      expect(calls[0]!.signal.aborted).toBe(false)
    }
  } finally {
    jest.useRealTimers()
  }
})

test("the native deadline includes retry waits and retains usage from completed attempts", async () => {
  const busy: DialectCompactOutcome = {
    ok: false,
    error: { message: "HTTP 503" },
    retryable: true,
    unsupported: false,
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const { ai, calls, saved, req } = setup([busy, ok()], "https://official.example", undefined, {
    retries: 3,
    baseDelayMs: 10_000,
    nativeCompactionTimeoutMs: 15,
  })
  expect(await ai.compact(req())).toMatchObject({ ok: false, timedOut: true, usage: { input: 10 } })
  expect(calls).toHaveLength(1)
  expect(saved).toEqual([])
})

test("user cancellation is not a timeout, even when the native provider ignores abort", async () => {
  const { ai, calls, req } = setup([() => new Promise(() => {})], "https://official.example", undefined, {
    nativeCompactionTimeoutMs: 0,
  })
  const caller = new AbortController()
  const done = ai.compact(req(), caller.signal)
  caller.abort()
  const result = await done
  expect(result).toMatchObject({ ok: false, aborted: true, error: "aborted" })
  expect(!result.ok && result.timedOut).toBeUndefined()
  expect(calls[0]!.signal.aborted).toBe(true)
})

test("remembered failures load from memory and are forgotten after a while", () => {
  let now = 1_000_000_000
  const memory = {
    load: () => ({ k: { trigger: now - 1000, endpoint: now - FORGET_FAILURE_MS - 1 } }),
    save() {},
  }
  const f = new CompactionFailures(memory, () => now)
  expect([...f.skipped("k")]).toEqual(["trigger"])
  now += FORGET_FAILURE_MS
  expect([...f.skipped("k")]).toEqual([])
  // A memory that cannot be read or written only costs a wasted attempt.
  const broken = new CompactionFailures({
    load: () => {
      throw new Error("no disk")
    },
    save: () => {
      throw new Error("no disk")
    },
  })
  broken.remember("k", "trigger")
  expect([...broken.skipped("k")]).toEqual(["trigger"])
})

test("which failures say a way is unsupported", () => {
  expect(isUnsupportedCompaction(404, "not found")).toBe(true)
  expect(isUnsupportedCompaction(501, "/responses/compact not supported")).toBe(true)
  expect(isUnsupportedCompaction(400, "Invalid value: 'compaction_trigger'")).toBe(true)
  expect(isUnsupportedCompaction(400, "Unsupported parameter: compaction")).toBe(true)
  expect(isUnsupportedCompaction(400, "messages: field required")).toBe(false)
  expect(isUnsupportedCompaction(429, "slow down, compaction")).toBe(false)
  expect(isUnsupportedCompaction(500, "compaction broke")).toBe(false)
})
