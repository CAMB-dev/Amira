import { expect, test } from "bun:test"
import {
  SPAWN_TEST_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { grepMatcher } from "../src/grep-matcher.ts"
import { observeGrepWorkers } from "./grep-matcher-fixture.ts"

const delayedStartup = "await Bun.sleep(1500);\n"

function expectClosed(observed: ReturnType<typeof observeGrepWorkers>) {
  expect(observed.workers).toHaveLength(1)
  const entry = observed.workers[0]!
  expect(entry.terminated).toBe(true)
  expect(observed.revoked.has(entry.url)).toBe(true)
  expect(entry.worker.onmessage).toBeNull()
  expect(entry.listeners.size).toBe(0)
  expect(observed.timers.size).toBe(0)
}

test(
  "valid regex gets its full matching budget after delayed real worker startup",
  async () => {
    const observed = observeGrepWorkers(delayedStartup)
    const matcher = grepMatcher(/a+/, new AbortController().signal)
    const started = performance.now()
    try {
      expect(await waitForSpawnWork("delayed grep startup", matcher.match(["aaa"], false))).toEqual([[0]])
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_500)
      expect(await waitForSpawnWork("reused grep worker", matcher.match(["b\naaa"], false))).toEqual([[1]])
      expect(observed.workers).toHaveLength(1)
      matcher.close()
      expectClosed(observed)
    } finally {
      matcher.close()
      observed.restore()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "hostile regex still has a one-second batch budget after delayed startup",
  async () => {
    const observed = observeGrepWorkers(delayedStartup)
    const matcher = grepMatcher(/(a+)+$/, new AbortController().signal)
    const pending = matcher.match([`${"a".repeat(9_000)}!\n`.repeat(20)], false)
    void pending.catch(() => {})
    try {
      await waitForSpawnCondition(
        "hostile grep batch dispatched",
        () => observed.workers[0]?.started !== undefined,
      )
      const started = observed.workers[0]!.started!
      await expect(waitForSpawnWork("hostile grep timeout", pending)).rejects.toThrow(
        "Regular expression matching timed out (1 second for a batch of files)",
      )
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(4_000)
      expectClosed(observed)
    } finally {
      matcher.close()
      await pending.catch(() => {})
      observed.restore()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

for (const [label, prefix, message] of [
  ["failed", 'throw new Error("injected startup failure");\n', "The grep matching worker failed"],
  ["stopped", "process.exit(0);\n", "The grep matching worker stopped unexpectedly"],
]) {
  test(
    `${label} real worker startup settles and cleans up`,
    async () => {
      const observed = observeGrepWorkers(prefix)
      const matcher = grepMatcher(/a+/, new AbortController().signal)
      try {
        await expect(
          waitForSpawnWork(`${label} grep startup`, matcher.match(["aaa"], false)),
        ).rejects.toThrow(message)
        expect(observed.workers[0]!.started).toBeUndefined()
        expectClosed(observed)
      } finally {
        matcher.close()
        observed.restore()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

test(
  "worker readiness has its own bounded startup deadline and cleanup",
  async () => {
    const observed = observeGrepWorkers(delayedStartup)
    const matcher = grepMatcher(/a+/, new AbortController().signal)
    const setTimeout = globalThis.setTimeout
    // Exercise the production startup deadline without spending 30 seconds in this fixture.
    globalThis.setTimeout = new Proxy(setTimeout, {
      apply(target, thisArg, args) {
        if (args[1] === 30_000) args[1] = 10
        return Reflect.apply(target, thisArg, args)
      },
    })
    const pending = matcher.match(["aaa"], false)
    globalThis.setTimeout = setTimeout
    try {
      await expect(waitForSpawnWork("grep startup deadline", pending)).rejects.toThrow(
        "The grep matching worker failed to start within 30 seconds",
      )
      expect(observed.workers[0]!.started).toBeUndefined()
      expectClosed(observed)
    } finally {
      globalThis.setTimeout = setTimeout
      matcher.close()
      await pending.catch(() => {})
      observed.restore()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

for (const action of ["abort", "close"]) {
  test(
    `${action} during real worker startup settles and cleans up`,
    async () => {
      const observed = observeGrepWorkers(delayedStartup)
      const controller = new AbortController()
      const matcher = grepMatcher(/a+/, controller.signal)
      const pending = matcher.match(["aaa"], false)
      void pending.catch(() => {})
      try {
        expect(observed.workers).toHaveLength(1)
        expect(observed.workers[0]!.started).toBeUndefined()
        if (action === "abort") controller.abort()
        else matcher.close()
        await expect(waitForSpawnWork(`${action} grep startup`, pending)).rejects.toThrow(
          action === "abort" ? "Aborted" : "The grep matching worker stopped unexpectedly",
        )
        expectClosed(observed)
      } finally {
        controller.abort()
        matcher.close()
        await pending.catch(() => {})
        observed.restore()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
