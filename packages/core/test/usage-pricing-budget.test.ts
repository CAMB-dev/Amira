import { expect, test } from "bun:test"
import { emptyUsage } from "@amira/ai"
import { addUsage, BudgetLedger, overBudget } from "../src/subagents/budget.ts"

test("mutable tree/group accounting preserves prior known spending across an unpriced correction", () => {
  const ledger = new BudgetLedger({ costUsd: 4 })
  const group = emptyUsage()
  const rows = [
    { ...emptyUsage(), input: 5, webSearchRequests: 1, webSearchCost: 0.1, cost: 3 },
    { ...emptyUsage(), input: 10, webSearchRequests: 1 },
    { ...emptyUsage(), input: -10, webSearchRequests: -1 },
    { ...emptyUsage(), input: 10, webSearchRequests: 1, webSearchCost: 0.2, cost: 2 },
  ]
  for (const row of rows) {
    ledger.add(row)
    addUsage(group, row)
  }
  expect(ledger.usage.cost).toBe(5)
  expect(group.cost).toBe(5)
  expect(overBudget(group, { costUsd: 4 })).toBe("$5.0000 spent, limit $4")
  expect(ledger.carve({ costUsd: 1 })).toEqual({ costUsd: 0 })
})

test("known spending exhausts a cost budget even when another search still has unknown pricing", () => {
  const ledger = new BudgetLedger({ costUsd: 1 })
  const group = emptyUsage()
  for (const usage of [
    { ...emptyUsage(), webSearchRequests: 1 },
    { ...emptyUsage(), webSearchRequests: 1, webSearchCost: 0.1, cost: 2 },
  ]) {
    ledger.add(usage)
    addUsage(group, usage)
  }
  expect(ledger.usage.cost).toBeUndefined()
  expect(group.cost).toBeUndefined()
  expect(overBudget(group, { costUsd: 1 })).toBe("$2.0000 spent, limit $1")
  expect(ledger.carve({ costUsd: 1 })).toEqual({ costUsd: 0 })
})

test("carving uses the known minimum rather than resetting spending to zero for an unpriced search", () => {
  const ledger = new BudgetLedger({ costUsd: 1 })
  ledger.add({ ...emptyUsage(), cost: 0.75 })
  ledger.add({ ...emptyUsage(), webSearchRequests: 1 })
  expect(ledger.usage.cost).toBeUndefined()
  expect(ledger.carve({ costUsd: 1 })).toEqual({ costUsd: 0.25 })
})
