import "../server/offline.ts"
import { expect, test } from "bun:test"
import { ModelOutboundFilter } from "../../src/remote/model-outbound-filter.ts"
import { secretPatterns } from "../../src/remote/secret-patterns.ts"

test("compiled secret matching remains literal, including regex syntax and escapes", () => {
  const key = "KEY.[x]+(y)^$|\\end"
  const patterns = secretPatterns(Object.freeze([key]))
  expect(patterns.contains(`before ${key} after`)).toBe(true)
  expect(patterns.contains("KEY-anyxyend")).toBe(false)
  expect(patterns.holdback).toBe(key.length - 1)
})

test("mutable callers cannot stale a canonical pattern snapshot or an active call", () => {
  const facts = ["FIRST_PRIVATE_KEY"]
  const first = secretPatterns(facts)
  const active = new ModelOutboundFilter(facts)
  facts[0] = "SECOND_PRIVATE_KEY"
  const second = secretPatterns(facts)
  expect(second).not.toBe(first)
  expect(second.contains(facts[0]!)).toBe(true)
  expect(second.contains("FIRST_PRIVATE_KEY")).toBe(false)
  expect(first.contains("FIRST_PRIVATE_KEY")).toBe(true)
  const output = [
    ...active.push({ kind: "event", value: { type: "text.delta", text: "FIRST_PRIVATE_KEY" } }),
    ...active.flush(),
  ]
  expect(JSON.stringify(output)).not.toContain("FIRST_PRIVATE_KEY")
})

test("mixed numeric fragments preserve exact integer and fractional equivalence", () => {
  const integer = "1000000000000000128"
  const fraction = "0.1000000000000000055511151231257827021181583404541015625"
  const patterns = secretPatterns(Object.freeze([`SENTINEL_${integer}`, `SENTINEL_${fraction}`]))
  expect(patterns.representations(Number(integer))).toContain(integer)
  expect(patterns.representations(Number(fraction))).toContain(fraction)
  expect(patterns.representations(0.1)).toBe(patterns.representations(0.1))
  expect(Object.isFrozen(patterns.representations(0.1))).toBe(true)
})

test("reused canonical facts retain numeric-equivalence guards", () => {
  const facts = Object.freeze(["1000000000000000000000"])
  expect(secretPatterns(facts)).toBe(secretPatterns(facts))
  expect(secretPatterns(facts).numeric.has(1e21)).toBe(true)
})
