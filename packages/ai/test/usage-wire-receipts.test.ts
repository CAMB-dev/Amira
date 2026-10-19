import { expect, test } from "bun:test"
import * as sharedAccounting from "@amira/ai-shared/accounting"
import * as accounting from "../src/accounting.ts"
import * as ai from "../src/index.ts"

test("wire receipts are available only through existing host accounting exports", () => {
  const expected = [
    "decodeUsageReceipt",
    "encodeUsageReceipt",
    "hasUnpricedUsage",
    "isUsageAggregate",
    "knownUsageCost",
    "transferUsageAccounting",
  ]
  expect(Object.keys(accounting).sort()).toEqual(expected)
  expect(Object.keys(sharedAccounting).sort()).toEqual(expected)
  expect(Object.hasOwn(ai, "encodeUsageReceipt")).toBe(false)
  expect(Object.hasOwn(ai, "decodeUsageReceipt")).toBe(false)
})

test("negative aggregate receipts retain signed cost and coverage corrections", () => {
  const aggregate = ai.addUsage(
    { ...ai.emptyUsage(), cost: 2 },
    { ...ai.emptyUsage(), output: 3, webSearchRequests: 1, pricingUnknown: true },
  )
  const reverse = {
    ...aggregate,
    input: -aggregate.input,
    output: -aggregate.output,
    cacheRead: -aggregate.cacheRead,
    cacheWrite: -aggregate.cacheWrite,
    webSearchRequests: -aggregate.webSearchRequests!,
  }
  accounting.transferUsageAccounting(aggregate, reverse, -1)
  const restored = JSON.parse(JSON.stringify(reverse))
  accounting.decodeUsageReceipt(restored, JSON.parse(JSON.stringify(accounting.encodeUsageReceipt(reverse))))
  expect(accounting.knownUsageCost(restored)).toBe(-2)
  expect(accounting.isUsageAggregate(restored)).toBe(true)
  const cancelled = ai.addUsage(aggregate, restored)
  expect(cancelled.cost).toBe(0)
  expect(accounting.hasUnpricedUsage(cancelled)).toBe(false)
  expect(cancelled.pricingUnknown).toBeUndefined()
})
