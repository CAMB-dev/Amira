import { expect, spyOn, test } from "bun:test"
import {
  assertInlineResponsive,
  automaticCleanupLatency,
  type InlineLatencySample,
} from "./file-lock-latency-timing.ts"

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

async function measuredCallbacks(durations: number[], baselineJitter = 0) {
  const timing = await automaticCleanupLatency("callback regression")
  let clock = 0
  const now = spyOn(performance, "now").mockImplementation(() => clock)
  try {
    for (const duration of durations) {
      // Dispatch real timers through the helper's wrapper. Advancing the clock
      // inside the callback reproduces a deschedule without a wall-clock flake.
      // Unrelated fast callbacks must not dilute the attempted-cleanup samples.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const dispatched = new Promise<void>((resolve) =>
        setTimeout(() => {
          timing.noteAttempt()
          clock += duration
          resolve()
        }, 0),
      )
      clock += baselineJitter + 1
      await dispatched
    }
    await timing.waitForSamples()
    expect(timing.attempts).toBe(durations.length)
    return timing
  } finally {
    now.mockRestore()
    spyOn(globalThis, "setTimeout").mockRestore()
  }
}

test("automatic callback timing tolerates one deschedule during dispatch", async () => {
  const timing = await measuredCallbacks([150, 5, 6])
  expect(() => timing.assertResponsive()).not.toThrow()
})

test("automatic callback timing rejects persistent 150ms stalls despite unrelated fast timers", async () => {
  const timing = await measuredCallbacks([150, 150, 150])
  expect(() => timing.assertResponsive()).toThrow()
})

test("automatic callback timing cannot let a stalled baseline hide persistent 150ms stalls", async () => {
  const timing = await measuredCallbacks([150, 150, 150], 1000)
  expect(() => timing.assertResponsive()).toThrow()
})
