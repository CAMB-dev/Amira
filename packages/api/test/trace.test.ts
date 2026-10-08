import { expect, test } from "bun:test"
import type { Usage } from "@amira/ai"
import { summarizeTrace, type ToolOutcome, TRACE_VERSION, type TraceRecord } from "../src/trace.ts"

const header = (startedAt = 0): TraceRecord => ({
  type: "trace",
  v: TRACE_VERSION,
  sessionId: "main",
  startedAt,
})
const tool = (
  start: number,
  end: number,
  overrides: Partial<Extract<TraceRecord, { type: "tool" }>> = {},
): TraceRecord => ({
  type: "tool",
  turnId: "turn",
  toolCallId: `call-${start}`,
  name: "read",
  start,
  end,
  durationMs: end - start,
  outcome: "ok",
  argsChars: 2,
  resultChars: 0,
  argsPreview: "{}",
  resultPreview: "",
  ...overrides,
})
const turn = (start: number, end: number): TraceRecord => ({
  type: "turn",
  turnId: `turn-${start}`,
  start,
  end,
  reason: "done",
  steps: 1,
})
const usage = (overrides: Partial<Usage> = {}): Usage => ({
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  cost: 0.25,
  ...overrides,
})

test("host diagnostics change neither the timing nor the agent accounting", () => {
  const summary = summarizeTrace([
    header(),
    { type: "diagnostic", at: 10, message: "Windows console output code page changed to 936" },
  ])
  expect(summary.wallTimeMs).toBe(0)
  expect(summary.tools).toEqual({})
  expect(summary.failures).toEqual([])
  expect(summary.modelTimeMs).toBe(0)
  expect(summary.toolTimeMs).toBe(0)
  expect(summary.usage.input).toBe(0)
})

test("empty traces have zero metrics, no times, and no invented price", () => {
  const summary = summarizeTrace([])
  expect(summary.wallTimeMs).toBe(0)
  expect(summary.start).toBeUndefined()
  expect(summary.end).toBeUndefined()
  expect(summary.modelTimeMs).toBe(0)
  expect(summary.toolTimeMs).toBe(0)
  expect(summary.idleMs).toBe(0)
  expect(summary.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  expect(summary.totalUsage.cost).toBeUndefined()
  expect(summary.tools).toEqual({})
  expect(summary.failures).toEqual([])
  expect(summary.subagents).toEqual([])
})

test("parallel tool intervals are unioned separately from durations and approval waits", () => {
  const summary = summarizeTrace([
    header(),
    tool(20, 50, { durationMs: 60, approvalWaitMs: 30, outcome: "denied" }),
    tool(10, 30, { durationMs: 25, approvalWaitMs: 5 }),
    { type: "status", at: 60, status: "idle" },
  ])
  expect(summary.start).toBe(0)
  expect(summary.end).toBe(60)
  expect(summary.wallTimeMs).toBe(60)
  expect(summary.toolTimeMs).toBe(40)
  expect(summary.toolDurationMs).toBe(85)
  expect(summary.approvalWaitMs).toBe(35)
  expect(summary.tools.read).toEqual({
    count: 2,
    totalMs: 85,
    avgMs: 42.5,
    maxMs: 60,
    outcomes: { ok: 1, error: 0, denied: 1, aborted: 0, invalid: 0, "unknown-tool": 0 },
  })
})

test("wall bounds follow event times, not completion order or array endpoints", () => {
  const summary = summarizeTrace([tool(20, 100), tool(0, 10), { type: "status", at: 60, status: "working" }])
  expect(summary.start).toBe(0)
  expect(summary.end).toBe(100)
  expect(summary.wallTimeMs).toBe(100)
  expect(summary.toolTimeMs).toBe(90)
})

test("model time separates observed waiting, streaming and unknown first-token intervals", () => {
  const summary = summarizeTrace([
    {
      type: "model",
      model: "mock/test",
      start: 10,
      firstToken: 40,
      end: 100,
      retries: [
        { at: 20, delayMs: 10, kind: "rate-limit" },
        { at: 30, delayMs: 5, kind: "overloaded" },
      ],
    },
    { type: "model", model: "mock/test", start: 110, end: 140 },
  ])
  expect(summary.modelTimeMs).toBe(120)
  expect(summary.modelWaitMs).toBe(30)
  expect(summary.modelStreamMs).toBe(60)
  expect(summary.modelUnknownMs).toBe(30)
  expect(summary.retries).toBe(2)
})

test("idle is gaps between unioned turn intervals and excludes resume downtime", () => {
  const summary = summarizeTrace([
    header(),
    turn(40, 60),
    turn(10, 25),
    turn(20, 30),
    header(1000),
    turn(1010, 1040),
    turn(1050, 1060),
  ])
  expect(summary.wallTimeMs).toBe(1060)
  expect(summary.idleMs).toBe(20)
})

test("every non-ok tool disposition and failed turn appears with completion time", () => {
  const outcomes: ToolOutcome[] = ["ok", "error", "denied", "aborted", "invalid", "unknown-tool"]
  const records: TraceRecord[] = outcomes.map((outcome, i) =>
    tool(i * 10, i * 10 + 5, { outcome, resultPreview: outcome }),
  )
  records.push(
    {
      type: "turn",
      turnId: "failed",
      start: 0,
      end: 12,
      steps: 0,
      reason: "error",
      failure: { kind: "auth", message: "No credentials" },
    },
    { type: "turn", turnId: "aborted", start: 60, end: 80, steps: 1, reason: "aborted" },
  )
  const summary = summarizeTrace(records)
  expect(summary.tools.read?.outcomes).toEqual({
    ok: 1,
    error: 1,
    denied: 1,
    aborted: 1,
    invalid: 1,
    "unknown-tool": 1,
  })
  expect(summary.failures).toHaveLength(7)
  expect(summary.failures.map((failure) => failure.at)).toEqual([12, 15, 25, 35, 45, 55, 80])
  expect(summary.failures[0]).toEqual({
    type: "turn",
    at: 12,
    turnId: "failed",
    reason: "error",
    kind: "auth",
    message: "No credentials",
  })
  expect(summary.failures[1]).toEqual({
    type: "tool",
    at: 15,
    turnId: "turn",
    toolCallId: "call-10",
    name: "read",
    outcome: "error",
    message: "error",
  })
  expect(summary.failures.at(-1)).toEqual({
    type: "turn",
    at: 80,
    turnId: "aborted",
    reason: "aborted",
  })
})

test("usage preserves reasoning and separates own cost from direct-child cost", () => {
  const records: TraceRecord[] = [
    { type: "model", model: "mock/test", start: 0, end: 10, usage: usage({ reasoning: 3 }) },
    { type: "compact", start: 10, end: 20, reason: "manual", usage: usage({ reasoning: 2 }) },
    { type: "side", at: 25, model: "mock/test", usage: usage() },
    {
      type: "subagent",
      childSessionId: "child",
      role: "coder",
      title: "Write tests",
      queuedAt: -5,
      start: 10,
      end: 30,
      status: "done",
      durationMs: 20,
      usage: usage({ cost: 1, reasoning: 4 }),
    },
  ]
  const original = structuredClone(records)
  const summary = summarizeTrace(records)
  expect(records).toEqual(original)
  expect(summary.start).toBe(-5)
  expect(summary.usage).toEqual({
    input: 30,
    output: 15,
    cacheRead: 6,
    cacheWrite: 3,
    reasoning: 5,
    cost: 0.75,
  })
  expect(summary.subagentUsage).toEqual(usage({ cost: 1, reasoning: 4 }))
  expect(summary.totalUsage.cost).toBe(1.75)
  expect(summary.totalUsage.reasoning).toBe(9)
  expect(summary.totalUsage.input).toBe(40)
  expect(summary.subagents).toEqual([
    {
      childSessionId: "child",
      role: "coder",
      title: "Write tests",
      start: 10,
      end: 30,
      status: "done",
      durationMs: 20,
      cost: 1,
      usage: usage({ cost: 1, reasoning: 4 }),
    },
  ])
  summary.subagents[0]!.usage!.input = 999
  summary.usage.input = 999
  expect(records).toEqual(original)
})

test("unknown prices stay unknown even when later usages have known prices", () => {
  const unknown = usage({ cost: undefined, webSearchRequests: 1 })
  const priced = usage({ webSearchRequests: 2, webSearchCost: 0.1 })
  const summary = summarizeTrace([
    { type: "side", at: 0, model: "mock/test", usage: unknown },
    { type: "side", at: 1, model: "mock/test", usage: priced },
    { type: "side", at: 2, model: "mock/test", usage: priced },
  ])
  expect(summary.usage.webSearchRequests).toBe(5)
  expect(summary.usage.webSearchCost).toBeUndefined()
  expect(summary.usage.cost).toBeUndefined()
  expect(summary.totalUsage.cost).toBeUndefined()
  const partial = summarizeTrace([
    { type: "side", at: 0, model: "mock/test", usage: usage({ cost: undefined }) },
    { type: "side", at: 1, model: "mock/test", usage: usage() },
  ])
  expect(partial.totalUsage.cost).toBeUndefined()
})

test("tool names cannot collide with object prototype properties", () => {
  const summary = summarizeTrace([tool(0, 1, { name: "__proto__" }), tool(1, 3, { name: "constructor" })])
  expect(Object.keys(summary.tools)).toEqual(["__proto__", "constructor"])
  expect(Object.getOwnPropertyDescriptor(summary.tools, "__proto__")?.value.count).toBe(1)
  expect(summary.tools.constructor).toMatchObject({ count: 1, totalMs: 2 })
})
