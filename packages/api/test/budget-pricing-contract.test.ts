import { expect, expectTypeOf, test } from "bun:test"
import { API_VERSION, addUsage, type EventMap, emptyUsage, type Usage } from "../src/index.ts"

test("the public budget.update contract carries optional estimate metadata from API 0.1.54", () => {
  expectTypeOf<EventMap["budget.update"]["pricingUnknown"]>().toEqualTypeOf<boolean | undefined>()
  const confirmed = { tokens: 100, costUsd: 1 } satisfies EventMap["budget.update"]
  const estimated = {
    tokens: 200,
    costUsd: 3,
    pricingUnknown: true,
    limit: { costUsd: 10 },
  } satisfies EventMap["budget.update"]
  expect({ version: API_VERSION, confirmed, estimated }).toMatchInlineSnapshot(`
    {
      "confirmed": {
        "costUsd": 1,
        "tokens": 100,
      },
      "estimated": {
        "costUsd": 3,
        "limit": {
          "costUsd": 10,
        },
        "pricingUnknown": true,
        "tokens": 200,
      },
      "version": "0.1.69",
    }
  `)
})

test("Usage and aggregation remain available through the public API for estimate-aware consumers", () => {
  const estimated: Usage = { ...emptyUsage(), cost: 2, pricingUnknown: true }
  const total = addUsage(addUsage(emptyUsage(), estimated), { ...emptyUsage(), cost: 1 })
  expect(total.cost).toBe(3)
  expect(total.pricingUnknown).toBe(true)
  expect(JSON.parse(JSON.stringify(total))).toEqual(total)
})
