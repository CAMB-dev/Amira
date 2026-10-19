import { expect, test } from "bun:test"
import { addUsage, emptyUsage, type Usage } from "@amira/ai"
import {
  hasUnpricedUsage,
  isUsageAggregate,
  knownUsageCost,
  transferUsageAccounting,
} from "@amira/ai/accounting"
import { addUsage as apiAddUsage } from "../../api/src/ai.ts"

test("a signed search correction restores previous known costs and search fees", () => {
  const priced = Object.freeze({ ...emptyUsage(), cost: 3, webSearchRequests: 1, webSearchCost: 1 })
  const unknown = Object.freeze({ ...emptyUsage(), webSearchRequests: 1 })
  const credit = Object.freeze({ ...emptyUsage(), webSearchRequests: -1 })
  const correction = Object.freeze({ ...emptyUsage(), cost: 2, webSearchRequests: 1, webSearchCost: 2 })
  const total = addUsage(priced, unknown)
  expect(total.cost).toBeUndefined()
  expect(total.webSearchCost).toBeUndefined()
  const restored = addUsage(addUsage(total, credit), correction)
  expect(restored).toEqual({
    ...emptyUsage(),
    cost: 5,
    webSearchRequests: 2,
    webSearchCost: 3,
  })
  expect(total).toEqual({ ...emptyUsage(), webSearchRequests: 2 })
  expect(priced).toEqual({ ...emptyUsage(), cost: 3, webSearchRequests: 1, webSearchCost: 1 })
  expect(unknown).toEqual({ ...emptyUsage(), webSearchRequests: 1 })
  expect(credit).toEqual({ ...emptyUsage(), webSearchRequests: -1 })
  expect(correction).toEqual({ ...emptyUsage(), cost: 2, webSearchRequests: 1, webSearchCost: 2 })
})

test("another unresolved search hides display prices but not the budget's known minimum", () => {
  const previous = addUsage(
    { ...emptyUsage(), cost: 3, webSearchRequests: 1, webSearchCost: 1 },
    { ...emptyUsage(), webSearchRequests: 2 },
  )
  const corrected = addUsage(addUsage(previous, { ...emptyUsage(), webSearchRequests: -1 }), {
    ...emptyUsage(),
    cost: 2,
    webSearchRequests: 1,
    webSearchCost: 2,
  })
  expect(corrected).toEqual({ ...emptyUsage(), webSearchRequests: 3 })
  expect(knownUsageCost(corrected)).toBe(5)
  expect(knownUsageCost(corrected)).toBeGreaterThan(1)
  expect(knownUsageCost(previous)).toBe(3)
  const restored = addUsage(corrected, { ...emptyUsage(), webSearchRequests: -1 })
  expect(restored).toEqual({ ...emptyUsage(), webSearchRequests: 2, cost: 5, webSearchCost: 3 })
})

test("mutable numeric copies explicitly retain accounting without modifying the source", () => {
  const source = Object.freeze(
    addUsage(
      { ...emptyUsage(), input: 10, cost: 3, webSearchRequests: 1, webSearchCost: 1 },
      { ...emptyUsage(), output: 20, webSearchRequests: 1 },
    ),
  )
  const target: Usage = { ...source }
  expect(knownUsageCost(target)).toBeUndefined()
  transferUsageAccounting(source, target)
  expect(knownUsageCost(target)).toBe(3)
  const corrected = addUsage(addUsage(target, { ...emptyUsage(), output: -20, webSearchRequests: -1 }), {
    ...emptyUsage(),
    output: 30,
    cost: 2,
    webSearchRequests: 1,
    webSearchCost: 2,
  })
  Object.assign(target, corrected)
  transferUsageAccounting(corrected, target)
  expect(target).toEqual({
    ...emptyUsage(),
    input: 10,
    output: 30,
    cost: 5,
    webSearchRequests: 2,
    webSearchCost: 3,
  })
  expect(knownUsageCost(target)).toBe(5)
  expect(source).toEqual({ ...emptyUsage(), input: 10, output: 20, webSearchRequests: 2 })
  expect(knownUsageCost(source)).toBe(3)
  // Copying a raw, unpriced value must not leave the old target's private subtotal behind.
  const raw = { ...emptyUsage(), webSearchRequests: 1 }
  delete target.cost
  delete target.webSearchCost
  Object.assign(target, raw)
  transferUsageAccounting(raw, target)
  expect(knownUsageCost(target)).toBeUndefined()
  expect(addUsage(target, emptyUsage()).cost).toBeUndefined()
})

test("raw prices are a minimum and zero pricing stays distinct from absent pricing", () => {
  const raw = Object.freeze({ ...emptyUsage(), cost: 3, webSearchRequests: 1 })
  const total = addUsage(raw, emptyUsage())
  expect(total.cost).toBeUndefined()
  expect(knownUsageCost(raw)).toBe(3)
  expect(knownUsageCost(total)).toBe(3)
  expect(addUsage(total, { ...emptyUsage(), webSearchRequests: -1 }).cost).toBe(3)
  const zero = addUsage(
    { ...emptyUsage(), cost: 0, webSearchRequests: 1, webSearchCost: 0 },
    { ...emptyUsage(), webSearchRequests: 1 },
  )
  expect(zero.cost).toBeUndefined()
  expect(knownUsageCost(zero)).toBe(0)
  expect(addUsage(zero, { ...emptyUsage(), webSearchRequests: -1 })).toEqual({
    ...emptyUsage(),
    cost: 0,
    webSearchRequests: 1,
    webSearchCost: 0,
  })
  const absent = addUsage(emptyUsage(), { ...emptyUsage(), webSearchRequests: 1 })
  expect(knownUsageCost(absent)).toBeUndefined()
  expect(addUsage(absent, { ...emptyUsage(), webSearchRequests: -1 })).toEqual({
    ...emptyUsage(),
    webSearchRequests: 0,
  })
  expect(addUsage(emptyUsage(), { ...emptyUsage(), webSearchRequests: 0 })).toEqual({
    ...emptyUsage(),
    webSearchRequests: 0,
  })
})

test("raw signed JSON rows replay and merge identically through ai and API usage aliases", () => {
  const saved = JSON.stringify([
    { ...emptyUsage(), input: 100, cost: 3, webSearchRequests: 1, webSearchCost: 1 },
    { ...emptyUsage(), output: 10, webSearchRequests: 1 },
    { ...emptyUsage(), output: 20, webSearchRequests: 1 },
    { ...emptyUsage(), input: 200, cost: 7, webSearchRequests: 2, webSearchCost: 4 },
    { ...emptyUsage(), output: -10, webSearchRequests: -1 },
    { ...emptyUsage(), output: 15, cost: 2, webSearchRequests: 1, webSearchCost: 2 },
    { ...emptyUsage(), output: -20, webSearchRequests: -1 },
    { ...emptyUsage(), output: 25, cost: 4, webSearchRequests: 1, webSearchCost: 3 },
  ])
  const rows: Usage[] = JSON.parse(saved)
  for (const row of rows) Object.freeze(row)
  const expected = {
    ...emptyUsage(),
    input: 300,
    output: 40,
    cost: 16,
    webSearchRequests: 5,
    webSearchCost: 10,
  }
  expect(rows.reduce(addUsage, emptyUsage())).toEqual(expected)
  expect(rows.reduce(apiAddUsage, emptyUsage())).toEqual(expected)
  const group = rows.slice(0, 4).reduce(addUsage, emptyUsage())
  expect(group.cost).toBeUndefined()
  expect(knownUsageCost(group)).toBe(10)
  const corrections = rows.slice(4).reduce(apiAddUsage, emptyUsage())
  const merged = apiAddUsage(group, corrections)
  expect(merged).toEqual(expected)
  expect(Reflect.ownKeys(merged).sort()).toEqual(Object.keys(expected).sort())
  expect(JSON.stringify(rows)).toBe(saved)
})

test("search fee subtotals and output accounting remain independent of total cost pricing", () => {
  const feeOnly = addUsage(
    { ...emptyUsage(), output: 100, reasoning: 80, webSearchRequests: 1, webSearchCost: 2 },
    { ...emptyUsage(), output: 20, webSearchRequests: 1 },
  )
  const restored = addUsage(feeOnly, { ...emptyUsage(), webSearchRequests: -1 })
  expect(restored).toEqual({
    ...emptyUsage(),
    output: 120,
    webSearchRequests: 1,
    webSearchCost: 2,
  })
  expect(knownUsageCost(restored)).toBe(2)
  expect(addUsage({ ...emptyUsage(), cost: 3 }, { ...emptyUsage(), input: 5 })).toEqual({
    ...emptyUsage(),
    input: 5,
    cost: 3,
  })
  expect(addUsage({ ...emptyUsage(), cost: 3 }, { ...emptyUsage(), cost: -3 }).cost).toBe(0)
})

test("raw signed unknown amounts cannot cancel missing-price evidence", () => {
  const unknown = addUsage({ ...emptyUsage(), input: 10 }, { ...emptyUsage(), input: -10 })
  const total = addUsage(unknown, { ...emptyUsage(), cost: 0.3 })
  expect(total.input).toBe(0)
  expect(knownUsageCost(total)).toBe(0.3)
  expect(hasUnpricedUsage(total)).toBe(true)
})

test("unreported zero-counter metadata remains unknown through aggregation and copying", () => {
  const total = addUsage({ ...emptyUsage(), outputReported: false }, { ...emptyUsage(), input: 2, cost: 0.3 })
  const copy = { ...total }
  transferUsageAccounting(total, copy)
  expect(total.outputReported).toBe(false)
  expect(hasUnpricedUsage(copy)).toBe(true)
  expect(knownUsageCost(copy)).toBe(0.3)
})

test("an explicit search fee stays known when unreported token pricing prevents a total", () => {
  const usage = { ...emptyUsage(), input: 2, webSearchRequests: 1, webSearchCost: 2 }
  const total = addUsage(usage, emptyUsage())
  expect(total.cost).toBeUndefined()
  expect(knownUsageCost(total)).toBe(2)
  expect(hasUnpricedUsage(total)).toBe(true)
})

test("only explicit aggregation, not copying sparse raw metadata, carries replacement provenance", () => {
  const raw = { ...emptyUsage(), input: 10 }
  const copy = { ...raw }
  transferUsageAccounting(raw, copy)
  expect(isUsageAggregate(copy)).toBe(false)
  const aggregate = addUsage({ ...emptyUsage(), cost: 0.3 }, raw)
  const retained = { ...aggregate }
  transferUsageAccounting(aggregate, retained)
  expect(isUsageAggregate(retained)).toBe(true)
  retained.input++
  expect(isUsageAggregate(retained)).toBe(false)
})

test("coverage flags disappearing from an aggregate cannot erase its known subtotal or old gaps", () => {
  const aggregate = addUsage(
    { ...emptyUsage(), input: 10, cost: 0.3 },
    { ...emptyUsage(), webSearchRequests: 1, pricingUnknown: true, outputReported: false },
  )
  delete aggregate.pricingUnknown
  delete aggregate.outputReported
  const copy = { ...aggregate }
  transferUsageAccounting(aggregate, copy)
  expect(isUsageAggregate(copy)).toBe(true)
  expect(knownUsageCost(copy)).toBe(0.3)
  expect(hasUnpricedUsage(copy)).toBe(true)
})

test("accounting helpers are available only on the declared internal subpaths", async () => {
  const shared = await import("@amira/ai-shared")
  expect(Object.keys(shared).sort()).toEqual([
    "NATIVE_WEB_SEARCH",
    "addUsage",
    "describeServerTool",
    "emptyUsage",
    "hasUnpricedSearch",
    "serverToolText",
  ])
  const internal = await import("@amira/ai-shared/accounting")
  expect(Object.keys(internal).sort()).toEqual([
    "decodeUsageReceipt",
    "encodeUsageReceipt",
    "hasUnpricedUsage",
    "isUsageAggregate",
    "knownUsageCost",
    "transferUsageAccounting",
  ])
  expect(internal.hasUnpricedUsage).toBe(hasUnpricedUsage)
  expect(internal.isUsageAggregate).toBe(isUsageAggregate)
  expect(internal.knownUsageCost).toBe(knownUsageCost)
  expect(internal.transferUsageAccounting).toBe(transferUsageAccounting)
  expect(Object.keys(await import("@amira/ai/accounting")).sort()).toEqual([
    "decodeUsageReceipt",
    "encodeUsageReceipt",
    "hasUnpricedUsage",
    "isUsageAggregate",
    "knownUsageCost",
    "transferUsageAccounting",
  ])
})

test("unknown token prices cannot be hidden by a different contribution's visible subtotal", () => {
  const partial = addUsage({ ...emptyUsage(), input: 10, cost: 0.3 }, { ...emptyUsage(), output: 5 })
  expect(partial.cost).toBe(0.3)
  expect(knownUsageCost(partial)).toBe(0.3)
  expect(hasUnpricedUsage(partial)).toBe(true)
  expect(hasUnpricedUsage(addUsage(emptyUsage(), partial))).toBe(true)
  expect(hasUnpricedUsage(apiAddUsage(emptyUsage(), partial))).toBe(true)
  expect(hasUnpricedUsage({ ...emptyUsage(), cost: 0 })).toBe(false)
  expect(hasUnpricedUsage(emptyUsage())).toBe(false)
})

for (const contribution of [
  { ...emptyUsage(), output: 5 },
  { ...emptyUsage(), webSearchRequests: 1 },
  { ...emptyUsage(), pricingUnknown: true },
]) {
  test(`copies and inverse accounting cancel unresolved ${JSON.stringify(contribution)}`, () => {
    const partial = addUsage({ ...emptyUsage(), input: 10, cost: 0.3 }, contribution)
    const copy = { ...partial }
    transferUsageAccounting(partial, copy)
    expect(hasUnpricedUsage(copy)).toBe(true)
    const credit: Usage = {
      input: -copy.input,
      output: -copy.output,
      cacheRead: -copy.cacheRead,
      cacheWrite: -copy.cacheWrite,
      ...(copy.cost !== undefined ? { cost: -copy.cost } : {}),
      ...(copy.webSearchRequests !== undefined ? { webSearchRequests: -copy.webSearchRequests } : {}),
      ...(copy.pricingUnknown ? { pricingUnknown: true } : {}),
    }
    transferUsageAccounting(copy, credit, -1)
    expect(knownUsageCost(credit)).toBe(-0.3)
    const canceled = addUsage(copy, credit)
    expect(knownUsageCost(canceled)).toBe(0)
    expect(hasUnpricedUsage(canceled)).toBe(false)
    expect(canceled.pricingUnknown).toBeUndefined()
    expect(hasUnpricedUsage(addUsage(canceled, { ...emptyUsage(), input: 2, cost: 0.4 }))).toBe(false)
    expect(hasUnpricedUsage(partial)).toBe(true)
  })
}

test("changing a returned aggregate's public pricing invalidates its old private subtotal", () => {
  const aggregate = addUsage(emptyUsage(), { ...emptyUsage(), cost: 3 })
  aggregate.cost = 2
  const total = addUsage(aggregate, { ...emptyUsage(), cost: 1 })
  expect(total.cost).toBe(3)
  expect(knownUsageCost(aggregate)).toBe(2)
  delete aggregate.cost
  expect(knownUsageCost(aggregate)).toBeUndefined()
  expect(addUsage(aggregate, emptyUsage()).cost).toBeUndefined()
})
