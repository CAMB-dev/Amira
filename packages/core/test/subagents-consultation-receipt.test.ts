import { expect, test } from "bun:test"
import { addUsage, emptyUsage, type Usage } from "@amira/ai"
import { hasUnpricedUsage, knownUsageCost } from "@amira/ai/accounting"
import { usageCoverage } from "../src/accounting-coverage.ts"
import { markAccountingIncomplete } from "../src/accounting-receipts.ts"
import { consultationUsageRecorder } from "../src/subagents/consultation-usage.ts"
import { statementOf } from "../src/usage-statements.ts"

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
  expect(r.charges.map((u) => u.cost)).toEqual([2, -2, 3])
  expect(r.total().cost).toBe(3)
  expect(r.total().input).toBe(12)
})

test("final usage corrections include refunds rather than adding another complete charge", () => {
  const r = receipt()
  r.record.observe!({ ...emptyUsage(), input: 10, cost: 3 })
  r.record({ ...emptyUsage(), input: 8, cost: 2 })
  expect(r.charges.map((u) => u.cost)).toEqual([3, -3, 2])
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

for (const corrected of [1, 3]) {
  test(`partial known subtotals survive copies and a signed correction to ${corrected} before final pricing`, () => {
    const r = receipt()
    const partial = (cost: number) =>
      addUsage({ ...emptyUsage(), input: 10, cost }, { ...emptyUsage(), webSearchRequests: 1 })
    r.record.observe!(partial(2))
    expect(knownUsageCost(r.total())).toBe(2)
    r.record.observe!(partial(corrected))
    expect(knownUsageCost(r.total())).toBe(corrected)
    r.record({ ...emptyUsage(), input: 10, webSearchRequests: 1, webSearchCost: 0.1, cost: 4 })
    expect(r.total().cost).toBe(4)
    expect(r.total().webSearchRequests).toBe(1)
    expect(r.total().input).toBe(10)
  })
}

test("a newer partial aggregate replaces visible pricing with its own known subtotal", () => {
  const r = receipt()
  r.record.observe!({ ...emptyUsage(), input: 10, cost: 0.2 })
  r.record(addUsage({ ...emptyUsage(), input: 10, cost: 0.3 }, { ...emptyUsage(), webSearchRequests: 1 }))
  expect(knownUsageCost(r.total())).toBeCloseTo(0.3)
  expect(r.total().cost).toBeUndefined()
  expect(r.charges).toHaveLength(3)
})

test("coverage-only changes retain a replacement even when every amount is unchanged", () => {
  const r = receipt()
  const usage = { ...emptyUsage(), input: 10, cost: 0.2 }
  r.record.observe!(usage)
  r.record({ ...usage, outputReported: false })
  expect(knownUsageCost(r.total())).toBeCloseTo(0.2)
  expect(r.charges).toHaveLength(3)
  expect(r.charges.at(-1)?.outputReported).toBe(false)
})

test("signed revisions carry serializable full-state statements, not numerical delta coverage", () => {
  const r = receipt()
  const usage = { ...emptyUsage(), input: 10, cost: 0.2 }
  const first = r.record.observe!(usage)
  const statement = statementOf(first)!
  expect(statement).toMatchObject({ v: 1, revision: 1, kind: "snapshot", knownCostUsd: 0.2 })
  expect(statement.coverage).toMatchObject({ v: 1, reported: true, priced: true })
  const next = addUsage({ ...usage, cost: 0.3 }, { ...emptyUsage(), webSearchRequests: 1 })
  r.record(next)
  const [snapshot, credit, replacement] = r.charges.map(statementOf)
  expect(snapshot).toBe(statement)
  expect(credit).toMatchObject({ id: statement.id, revision: 1, kind: "credit", knownCostUsd: -0.2 })
  expect(credit?.usage.input).toBe(-10)
  expect(replacement).toMatchObject({
    id: statement.id,
    revision: 2,
    kind: "snapshot",
    knownCostUsd: 0.3,
    coverage: { v: 1, reported: true, priced: false },
  })
  expect(JSON.parse(JSON.stringify(replacement))).toEqual(replacement)
  usage.input = 999
  expect(statement.usage.input).toBe(10)
  r.record({ ...emptyUsage(), cost: 1 })
  expect(statementOf(r.charges.at(-1)!)?.id).not.toBe(statement.id)
  expect(statementOf(r.charges.at(-1)!)?.revision).toBe(1)
})

test("unknown token aggregates remain incomplete until their full contribution is replaced", () => {
  const r = receipt()
  const partial = addUsage({ ...emptyUsage(), input: 10, cost: 0.3 }, { ...emptyUsage(), output: 2 })
  r.record.observe!(partial)
  expect(usageCoverage(r.charges[0]!)).toMatchObject({ v: 1, reported: true, priced: false })
  expect(hasUnpricedUsage(r.total())).toBe(true)
  r.record({ ...emptyUsage(), input: 10, output: 2, cost: 0.4 })
  expect(knownUsageCost(r.total())).toBeCloseTo(0.4)
  expect(hasUnpricedUsage(r.total())).toBe(false)
})

test("identical observations return their retained booked contribution without fabricating rows", () => {
  const r = receipt()
  const source = { ...emptyUsage(), input: 10, cost: 0.2 }
  const retained = r.record.observe!(source)
  expect(retained).not.toBe(source)
  expect(r.record.observe!({ ...source })).toBe(retained)
  r.record({ ...source })
  expect(r.charges).toEqual([retained])
})

test("coverage-only incomplete markers also replace a numerically identical contribution", () => {
  const r = receipt()
  const source = { ...emptyUsage(), cost: 0.2 }
  r.record.observe!(source)
  const revised = { ...source }
  markAccountingIncomplete(revised)
  r.record(revised)
  expect(r.charges).toHaveLength(3)
  expect(statementOf(r.charges.at(-1)!)?.coverage).toMatchObject({ v: 1, reported: false, priced: false })
  expect(knownUsageCost(r.total())).toBeCloseTo(0.2)
})

test("missing optional terminal metadata cannot forget amounts that were already charged", () => {
  const r = receipt()
  const usage = { ...emptyUsage(), cost: 2, webSearchRequests: 1, webSearchCost: 0.01 }
  r.record.observe!(usage)
  r.record({ ...emptyUsage(), cost: undefined, webSearchRequests: undefined })
  expect(r.total().cost).toBe(2)
  expect(knownUsageCost(r.total())).toBe(2)
  expect(r.total().webSearchRequests).toBe(1)
  expect(r.total().webSearchCost).toBe(0.01)
  expect(statementOf(r.charges.at(-1)!)?.coverage.priced).toBe(false)
})
