import { expect, test } from "bun:test"
import { addUsage, emptyUsage, type Usage } from "@amira/ai"
import { consultationUsageRecorder } from "../src/subagents/consultation-usage.ts"

function receipt() {
  const charges: Usage[] = []
  let total = emptyUsage()
  const record = consultationUsageRecorder((usage) => {
    charges.push(usage)
    total = addUsage(total, usage)
  })
  return { record, charges, total: () => total }
}

test("known usage is charged immediately; reused snapshots and final settlement do not double charge", () => {
  const r = receipt()
  const usage = { ...emptyUsage(), input: 10, cost: 2 }
  r.record.observe!(usage)
  expect(r.total().cost).toBe(2)
  expect(r.total().input).toBe(10)
  usage.cost = 3
  usage.input = 12
  expect(r.charges[0]?.cost).toBe(2)
  r.record.observe!(usage)
  r.record(usage)
  expect(r.charges.map((u) => u.cost)).toEqual([2, 1])
  expect(r.total().cost).toBe(3)
  expect(r.total().input).toBe(12)
})

test("final usage corrections include refunds rather than adding another complete charge", () => {
  const r = receipt()
  r.record.observe!({ ...emptyUsage(), input: 10, cost: 3 })
  r.record({ ...emptyUsage(), input: 8, cost: 2 })
  expect(r.charges.map((u) => u.cost)).toEqual([3, -1])
  expect(r.total().cost).toBe(2)
  expect(r.total().input).toBe(8)
})

test("receipts reset per attempt, not per reused message or usage identity", () => {
  const r = receipt()
  const usage = { ...emptyUsage(), cost: 2 }
  r.record.observe!(usage)
  r.record(usage)
  usage.cost = 3
  r.record.observe!(usage)
  r.record(usage)
  expect(r.charges.map((u) => u.cost)).toEqual([2, 3])
  expect(r.total().cost).toBe(5)
})

for (const priced of [false, true]) {
  test(`unchanged search metadata stays once-only and preserves ${priced ? "known" : "unknown"} pricing`, () => {
    const r = receipt()
    const usage: Usage = {
      ...emptyUsage(),
      outputReported: false,
      webSearchRequests: 1,
      ...(priced ? { webSearchCost: 0.01, cost: 0.01 } : {}),
    }
    r.record.observe!(usage)
    r.record.observe!({ ...usage })
    r.record({ ...usage })
    expect(r.charges).toHaveLength(1)
    expect(r.charges[0]).toEqual(usage)
    expect(r.total().webSearchRequests).toBe(1)
    expect(r.total().cost).toBe(priced ? 0.01 : undefined)
    expect(r.total().webSearchCost).toBe(priced ? 0.01 : undefined)
  })
}

test("temporarily missing optional metadata cannot forget amounts that were already charged", () => {
  const r = receipt()
  const usage = { ...emptyUsage(), cost: 2, webSearchRequests: 1, webSearchCost: 0.01 }
  r.record.observe!(usage)
  r.record.observe!({ ...emptyUsage(), cost: undefined, webSearchRequests: undefined })
  r.record(usage)
  expect(r.charges).toHaveLength(1)
  expect(r.total().cost).toBe(2)
  expect(r.total().webSearchRequests).toBe(1)
  expect(r.total().webSearchCost).toBe(0.01)
})
