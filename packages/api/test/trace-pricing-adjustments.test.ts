import { expect, test } from "bun:test"
import { emptyUsage } from "../src/ai.ts"
import { summarizeTrace, type TraceRecord } from "../src/trace.ts"

test("trace pricing corrections clear only the unresolved search they replace", () => {
  const usages = [
    { ...emptyUsage(), input: 5, webSearchRequests: 1, webSearchCost: 0.1, cost: 3 },
    { ...emptyUsage(), input: 10, webSearchRequests: 1 },
    { ...emptyUsage(), input: -10, webSearchRequests: -1 },
    { ...emptyUsage(), input: 10, webSearchRequests: 1, webSearchCost: 0.2, cost: 2 },
  ]
  const records: TraceRecord[] = usages.map((usage, i) => ({ type: "side", at: i, model: "mock/m", usage }))
  expect(summarizeTrace(records).usage.cost).toBe(5)
  expect(summarizeTrace(records).usage.input).toBe(15)
  expect(summarizeTrace(records).usage.webSearchRequests).toBe(2)
  records.push({ type: "side", at: 5, model: "mock/m", usage: { ...emptyUsage(), webSearchRequests: 1 } })
  expect(summarizeTrace(records).usage.cost).toBeUndefined()
})
