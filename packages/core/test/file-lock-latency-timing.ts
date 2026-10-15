import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"

// Windows AV can delay both the Bun worker and its PowerShell reader by 4-10s.
// Include warmup and the nested spawn, but only as hang protection, not latency slack.
export const LATENCY_WORKER_READY_TIMEOUT_MS = 60000
export const LATENCY_WORKER_READY = "latency-worker-ready"

/** Finish all setup before the parent starts its operation watchdog. */
export async function latencyWorkerReady(dir: string) {
  const ready = path.join(dir, LATENCY_WORKER_READY)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    fs.writeFileSync(ready, "ready")
    const go = await Promise.race([
      Bun.stdin.text(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("latency worker go timed out")),
          LATENCY_WORKER_READY_TIMEOUT_MS,
        )
      }),
    ])
    if (go !== "go") throw new Error("latency worker requires go after readiness")
    fs.unlinkSync(ready)
  } finally {
    clearTimeout(timer)
  }
}

interface CallbackSample {
  attempted: boolean
  duration: number
  baselineJitter: number
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

export const INLINE_LATENCY_RUNS = 3
export const INLINE_LATENCY_REPORT = "INLINE_LATENCY "

export interface InlineLatencySample {
  entry: string
  duration: number
  baselineMs: number
}

/** Aggregate actual operations from fresh fixtures, not just repeated baselines. */
export function assertInlineResponsive(
  label: string,
  samples: readonly InlineLatencySample[],
  entries: readonly string[],
) {
  expect(samples).toHaveLength(entries.length * INLINE_LATENCY_RUNS)
  for (const entry of entries) {
    const measured = samples.filter((sample) => sample.entry === entry)
    expect(measured).toHaveLength(INLINE_LATENCY_RUNS)
    expect(
      measured.every(
        (sample) =>
          Number.isFinite(sample.duration) &&
          sample.duration >= 0 &&
          Number.isFinite(sample.baselineMs) &&
          sample.baselineMs >= 0,
      ),
    ).toBe(true)
    const excess = measured.map((sample) => sample.duration - Math.min(sample.baselineMs, 25))
    console.log(
      `${label} ${entry}: fresh-fixture durations ${measured.map((sample) => sample.duration.toFixed(2)).join(", ")}ms; median excess ${median(excess).toFixed(2)}ms; maximum excess ${Math.max(...excess).toFixed(2)}ms`,
    )
    // One suspended fixture must not decide responsiveness. A sustained stall
    // still fails the original median budget; a very large outlier cannot hide.
    expect(median(excess)).toBeLessThan(50)
    expect(Math.max(...excess)).toBeLessThan(100)
  }
}

/** Measure synchronous entry points, excluding zero-delay callback scheduling latency. */
export async function inlineCleanupLatency(label: string, baseline: () => void) {
  baseline()
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(0)
    const start = performance.now()
    baseline()
    samples.push(performance.now() - start)
  }
  const baselineMs = median(samples)
  const measured: InlineLatencySample[] = []
  return {
    samples: measured,
    report() {
      console.log(`${INLINE_LATENCY_REPORT}${JSON.stringify(measured)}`)
    },
    measure<T>(entry: string, action: () => T): T {
      const start = performance.now()
      try {
        return action()
      } finally {
        // Exceptional exits count too. Keep the original error/return value;
        // assertions run only after all fresh contended fixtures were exercised.
        const duration = performance.now() - start
        measured.push({ entry, duration, baselineMs })
        console.log(
          `${label} ${entry}: inline ${duration.toFixed(2)}ms; warm baseline ${baselineMs.toFixed(2)}ms`,
        )
      }
    },
  }
}

/** Measure whole automatic callbacks, not their scheduled delay or just renameSync. */
export async function automaticCleanupLatency(label: string) {
  const timeout = globalThis.setTimeout
  // Warm timer dispatch separately from module/filesystem startup. None of these
  // callbacks retires a gate, so none can satisfy the automatic sample requirement.
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => timeout(resolve, 0))
  const samples: CallbackSample[] = []
  let active: CallbackSample | undefined
  let attempts = 0
  spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(timeout, {
      apply(target, receiver, [callback, delay, ...args]) {
        const sample: CallbackSample = { attempted: false, duration: 0, baselineJitter: 0 }
        const baselineStart = performance.now()
        // A separate timer before the cleanup timer measures nearby scheduler jitter.
        // Use the original seam so the baseline is neither wrapped nor recursive.
        timeout(() => {
          sample.baselineJitter = Math.max(0, performance.now() - baselineStart - 1)
        }, 0)
        return Reflect.apply(target, receiver, [
          (...callbackArgs: unknown[]) => {
            const previous = active
            active = sample
            const start = performance.now()
            try {
              callback(...callbackArgs)
            } finally {
              sample.duration = performance.now() - start
              active = previous
              if (sample.attempted) samples.push(sample)
            }
          },
          delay,
          ...args,
        ])
      },
    }),
  )
  return {
    get attempts() {
      return attempts
    },
    noteAttempt() {
      if (!active || active.attempted) return
      active.attempted = true
      attempts++
    },
    async waitForSamples() {
      const deadline = performance.now() + 1500
      while (samples.length < 3) {
        if (performance.now() > deadline) throw new Error(`${label}: automatic callback samples timed out`)
        await new Promise<void>((resolve) => timeout(resolve, 2))
      }
    },
    assertResponsive() {
      expect(samples.length).toBeGreaterThanOrEqual(3)
      // Callback entry excludes scheduler delay before dispatch, but wall time
      // cannot distinguish an isolated in-callback deschedule from a slow callback.
      // The median tolerates that outlier; capped baseline subtraction still makes
      // persistent 150ms stalls fail even if nearby timer dispatch also stalls.
      const excess = samples.map((sample) => sample.duration - Math.min(sample.baselineJitter, 25))
      console.log(
        `${label}: automatic callback durations ${samples.map((sample) => sample.duration.toFixed(2)).join(", ")}ms; baseline jitter ${samples.map((sample) => sample.baselineJitter.toFixed(2)).join(", ")}ms; median excess ${median(excess).toFixed(2)}ms`,
      )
      expect(median(excess)).toBeLessThan(50)
    },
  }
}
