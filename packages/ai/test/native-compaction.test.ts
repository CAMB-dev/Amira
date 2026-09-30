import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { Dialect, DialectCompactOutcome, ProviderCompat } from "../src/dialect.ts"
import {
  CompactionFailures,
  FORGET_FAILURE_MS,
  isUnsupportedCompaction,
  type RememberedFailures,
} from "../src/native-compaction.ts"
import type { ModelRequest } from "../src/types.ts"

/** A dialect whose compaction answers from a script, one outcome per call, and records calls. */
function fakeDialect(outcomes: DialectCompactOutcome[]) {
  const calls: { method: string; req: ModelRequest }[] = []
  const dialect: Dialect = {
    id: "fake",
    async *stream() {},
    compaction: {
      methods: ["first", "second"],
      layouts: ["tail", "recent-user"],
      midTurn: true,
      official: (baseUrl) => baseUrl.startsWith("https://official."),
      async compact(method, req) {
        calls.push({ method, req })
        return (
          outcomes.shift() ?? {
            ok: false,
            error: { message: "no script" },
            unsupported: false,
            retryable: false,
          }
        )
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
  outcomes: DialectCompactOutcome[],
  baseUrl = "http://proxy.local/v1",
  compat?: ProviderCompat,
) {
  const { dialect, calls } = fakeDialect(outcomes)
  const saved: RememberedFailures[] = []
  const ai = createAi({
    dialects: [dialect],
    retry: { retries: 2, baseDelayMs: 1 },
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
