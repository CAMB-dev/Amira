import { expect, test } from "bun:test"
import { assertInlineResponsive, type InlineLatencySample } from "./file-lock-latency-timing.ts"

function samples(durations: number[]): InlineLatencySample[] {
  return durations.map((duration) => ({ entry: "claim", duration, baselineMs: 1.01 }))
}

test("inline aggregation tolerates one suspended fixture without loosening the median budget", () => {
  // Match the review's externally suspended claim: 85.50ms, 1.01ms baseline.
  expect(() => assertInlineResponsive("descheduled", samples([85.5, 5, 6]), ["claim"])).not.toThrow()
})

test("inline aggregation rejects a persistent 150ms stall", () => {
  expect(() => assertInlineResponsive("persistent stall", samples([150, 150, 150]), ["claim"])).toThrow()
})

test("inline aggregation cannot hide an unbounded outlier behind a fast median", () => {
  expect(() => assertInlineResponsive("unbounded outlier", samples([1000, 5, 6]), ["claim"])).toThrow()
})
