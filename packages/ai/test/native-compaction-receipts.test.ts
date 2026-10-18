import { expect, jest, test } from "bun:test"
import { knownUsageCost } from "../src/accounting.ts"
import { createAi } from "../src/client.ts"
import type { Dialect, DialectCompactOutcome } from "../src/dialect.ts"
import type { CompactReceipt } from "../src/index.ts"
import { addUsage, emptyUsage } from "../src/types.ts"

const reported = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }
const success: DialectCompactOutcome = { ok: true, value: "checkpoint", usage: reported }
const failure: DialectCompactOutcome = {
  ok: false,
  error: { message: "busy", status: 503 },
  unsupported: false,
  retryable: true,
  usage: reported,
}

function setup(outcome: () => Promise<DialectCompactOutcome>, timeoutMs = 10, priced = true) {
  let calls = 0
  const dialect: Dialect = {
    id: "receipts",
    async *stream() {},
    compaction: {
      methods: ["compact"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        calls++
        return outcome()
      },
    },
  }
  const ai = createAi({
    dialects: [dialect],
    providers: [
      {
        id: "p",
        dialect: dialect.id,
        baseUrl: "https://mock.example",
        ...(priced ? { defaultModel: { cost: { input: 2, output: 10 } } } : {}),
      },
    ],
    retry: { nativeCompactionTimeoutMs: timeoutMs, baseDelayMs: 0, retries: 1 },
  })
  const req = { model: ai.model("p/m"), messages: [], systemPrompt: "", tools: [] }
  return { ai, req, calls: () => calls }
}

for (const stop of ["timeout", "cancel"] as const) {
  test(`a ${stop} result still delivers the native attempt's late priced receipt exactly once`, async () => {
    jest.useFakeTimers()
    try {
      const late = Promise.withResolvers<DialectCompactOutcome>()
      const { ai, req, calls } = setup(() => late.promise)
      const receipts: CompactReceipt[] = []
      const caller = new AbortController()
      const done = ai.compact(req, caller.signal, undefined, (receipt) => {
        receipts.push(receipt)
      })
      if (stop === "timeout") jest.advanceTimersByTime(10)
      else caller.abort()
      const result = await done
      expect(result).toMatchObject({
        ok: false,
        usage: { input: 0, output: 0 },
        usageIncomplete: true,
        ...(stop === "timeout" ? { timedOut: true } : { aborted: true }),
      })
      const snapshot = structuredClone(result)
      expect(receipts).toEqual([])
      late.resolve({
        ok: true,
        value: "late checkpoint",
        usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      })
      // Drain both the mock adapter and the client's native operation.
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.id).toBeString()
      expect(receipts[0]!.late).toBe(true)
      expect(receipts[0]!.usage).toMatchObject({ input: 1000, output: 100, cost: 0.003 })
      expect(result).toEqual(snapshot)
      expect(calls()).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })

  for (const rejected of [false, true]) {
    test(`late ${rejected ? "rejection" : "failure"} after ${stop} emits one receipt without retrying`, async () => {
      jest.useFakeTimers()
      try {
        const late = Promise.withResolvers<DialectCompactOutcome>()
        const { ai, req, calls } = setup(() => late.promise)
        const receipts: CompactReceipt[] = []
        const caller = new AbortController()
        const done = ai.compact(req, caller.signal, undefined, async (receipt) => {
          receipts.push(receipt)
          throw new Error("observer failed")
        })
        if (stop === "timeout") jest.advanceTimersByTime(10)
        else caller.abort()
        const result = await done
        const snapshot = structuredClone(result)
        if (rejected) late.reject(new Error("late provider error"))
        else late.resolve(failure)
        for (let i = 0; i < 10; i++) await Promise.resolve()
        expect(receipts).toHaveLength(1)
        expect(receipts[0]!.late).toBe(true)
        expect(receipts[0]!.usage).toEqual(rejected ? undefined : { ...reported, cost: 0.003 })
        expect(result).toEqual(snapshot)
        expect(calls()).toBe(1)
      } finally {
        jest.useRealTimers()
      }
    })
  }
}

for (const observer of ["normal", "throws", "rejects"] as const) {
  test(`timely identical retry receipts are distinct and not doubled when observer ${observer}`, async () => {
    let attempts = 0
    const { ai, req, calls } = setup(async () => (++attempts === 1 ? failure : success), 0)
    const receipts: CompactReceipt[] = []
    const result = await ai.compact(req, undefined, undefined, (receipt) => {
      receipts.push(receipt)
      if (observer === "throws") throw new Error("observer failed")
      if (observer === "rejects") return Promise.reject(new Error("observer failed"))
    })
    expect(result.ok).toBe(true)
    expect(result.usage).toMatchObject({ input: 2000, output: 200, cost: 0.006 })
    expect(receipts).toHaveLength(2)
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(2)
    expect(receipts.map((receipt) => receipt.late)).toEqual([false, false])
    expect(receipts.map((receipt) => receipt.usage)).toEqual([
      { ...reported, cost: 0.003 },
      { ...reported, cost: 0.003 },
    ])
    expect(calls()).toBe(2)
    await Promise.resolve()
  })
}

test("late receipts stay with their original observer when another compaction replaces it", async () => {
  const late = Promise.withResolvers<DialectCompactOutcome>()
  let attempts = 0
  const { ai, req } = setup(() => (++attempts === 1 ? late.promise : Promise.resolve(success)), 0)
  const original: CompactReceipt[] = []
  const replacement: CompactReceipt[] = []
  const caller = new AbortController()
  const done = ai.compact(req, caller.signal, undefined, (receipt) => {
    original.push(receipt)
  })
  caller.abort()
  await done
  await ai.compact(req, undefined, undefined, (receipt) => {
    replacement.push(receipt)
  })
  expect(original).toEqual([])
  expect(replacement).toHaveLength(1)
  late.resolve(success)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(original).toHaveLength(1)
  expect(replacement).toHaveLength(1)
  expect(original[0]!.id).not.toBe(replacement[0]!.id)
})

test("missing and partial attempt coverage remains incomplete alongside known usage", async () => {
  for (const usage of [undefined, { ...reported, outputReported: false }]) {
    let attempts = 0
    const { ai, req } = setup(async () => (++attempts === 1 ? { ...failure, usage } : success), 0)
    const receipts: CompactReceipt[] = []
    const result = await ai.compact(req, undefined, undefined, (receipt) => {
      receipts.push(receipt)
    })
    expect(result).toMatchObject({ ok: true, usageIncomplete: true })
    expect(receipts).toHaveLength(2)
    expect(receipts[0]!.usage).toEqual(usage)
    expect(receipts[1]!.usage).toEqual({ ...reported, cost: 0.003 })
    expect(result.usage.input).toBe(usage ? 2000 : 1000)
  }
})

for (const ok of [true, false]) {
  test(`unpriced native retry tokens retain incomplete coverage on ${ok ? "success" : "failure"}`, async () => {
    let attempts = 0
    const unpriced = { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 }
    const priced = { ...unpriced, input: 30, output: 3, cost: 0.3 }
    const { ai, req } = setup(
      async () =>
        ++attempts === 1
          ? { ...failure, usage: unpriced }
          : ok
            ? { ...success, usage: priced }
            : { ...failure, retryable: false, usage: priced },
      0,
      false,
    )
    const receipts: CompactReceipt[] = []
    const result = await ai.compact(req, undefined, undefined, (receipt) => {
      receipts.push(receipt)
    })
    expect(result.usage).toMatchObject({ input: 50, output: 5, cost: 0.3 })
    expect(receipts.map((receipt) => receipt.usage)).toEqual([unpriced, priced])
    expect(knownUsageCost(result.usage)).toBe(0.3)
    expect(result).toMatchObject({ ok, usageIncomplete: true })
  })
}

test("zero usage and explicitly free tokens do not introduce missing-price coverage", async () => {
  for (const usage of [emptyUsage(), { ...reported, cost: 0 }]) {
    const { ai, req } = setup(async () => ({ ...success, usage }), 0, false)
    const result = await ai.compact(req)
    expect(result.ok).toBe(true)
    expect(result.usageIncomplete).toBeUndefined()
  }
})

test("a rejected native attempt emits one missing-usage receipt and resolves as a failure", async () => {
  const { ai, req, calls } = setup(async () => {
    throw new Error("provider threw")
  }, 0)
  const receipts: CompactReceipt[] = []
  const result = await ai.compact(req, undefined, undefined, (receipt) => {
    receipts.push(receipt)
  })
  expect(result).toMatchObject({ ok: false, usageIncomplete: true, error: "compact: provider threw" })
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ late: false, usage: undefined })
  expect(calls()).toBe(1)
})

test("native receipt copies preserve a known subtotal alongside unpriced usage", async () => {
  const usage = addUsage({ ...reported, cost: 0.003 }, { ...emptyUsage(), webSearchRequests: 1 })
  const { ai, req } = setup(async () => ({ ...success, usage }), 0)
  let received: CompactReceipt | undefined
  const result = await ai.compact(req, undefined, undefined, (receipt) => {
    received = receipt
  })
  expect(received?.usage?.cost).toBeUndefined()
  expect(knownUsageCost(received!.usage!)).toBe(0.003)
  expect(knownUsageCost(result.usage)).toBe(0.003)
  expect(result.usageIncomplete).toBe(true)
})

test("observer mutation cannot change the returned aggregate or provider usage", async () => {
  const { ai, req } = setup(async () => success, 0)
  const result = await ai.compact(req, undefined, undefined, (receipt) => {
    if (receipt.usage) receipt.usage.input = 9000
  })
  expect(result.usage.input).toBe(1000)
  expect(reported.input).toBe(1000)
})

test("a late retry does not change the known subtotal returned at the deadline", async () => {
  jest.useFakeTimers()
  try {
    const late = Promise.withResolvers<DialectCompactOutcome>()
    let attempts = 0
    const { ai, req, calls } = setup(() => (++attempts === 1 ? Promise.resolve(failure) : late.promise))
    const receipts: CompactReceipt[] = []
    const done = ai.compact(req, undefined, undefined, (receipt) => {
      receipts.push(receipt)
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    jest.advanceTimersByTime(0)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(calls()).toBe(2)
    jest.advanceTimersByTime(10)
    const result = await done
    expect(result).toMatchObject({
      ok: false,
      timedOut: true,
      usageIncomplete: true,
      usage: { input: 1000, output: 100, cost: 0.003 },
    })
    const snapshot = structuredClone(result)
    late.resolve(success)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(receipts.map((receipt) => receipt.late)).toEqual([false, true])
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(2)
    expect(result).toEqual(snapshot)
    expect(calls()).toBe(2)
  } finally {
    jest.useRealTimers()
  }
})

test("no physical attempt means no receipt", async () => {
  const { ai, req, calls } = setup(async () => success, 0)
  const receipts: CompactReceipt[] = []
  const caller = new AbortController()
  caller.abort()
  await ai.compact(req, caller.signal, undefined, (receipt) => {
    receipts.push(receipt)
  })
  ai.registerProvider({ ...ai.providers()[0]!, compat: { compaction: "off" } })
  await ai.compact(req, undefined, undefined, (receipt) => {
    receipts.push(receipt)
  })
  expect(receipts).toEqual([])
  expect(calls()).toBe(0)
})
