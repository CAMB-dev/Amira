import { expect, test } from "bun:test"
import { addUsage, emptyUsage, type Usage } from "@amira/ai"
import { addUsage as apiAddUsage } from "../../api/src/ai.ts"

for (const [name, sum] of [
  ["ai", addUsage],
  ["api", apiAddUsage],
] as const) {
  test(`${name} usage sums retain an estimate marker in either operand without losing numeric costs`, () => {
    const confirmed: Usage = { ...emptyUsage(), input: 100, cost: 0.00075 }
    const estimate: Usage = { ...emptyUsage(), input: 10_000, cost: 0.08, pricingUnknown: true }
    for (const total of [sum(confirmed, estimate), sum(estimate, confirmed)]) {
      expect(total).toMatchObject({ input: 10_100, pricingUnknown: true })
      expect(total.cost).toBeCloseTo(0.08075, 12)
      const continued = sum(total, confirmed)
      expect(continued.pricingUnknown).toBe(true)
      expect(continued.cost).toBeCloseTo(0.0815, 12)
      expect(JSON.parse(JSON.stringify(continued))).toEqual(continued)
    }
    expect(sum(confirmed, confirmed)).not.toHaveProperty("pricingUnknown")
    expect(sum(emptyUsage(), emptyUsage())).not.toHaveProperty("pricingUnknown")
    expect(sum({ ...confirmed, pricingUnknown: false }, confirmed).pricingUnknown).not.toBe(true)
  })
}
