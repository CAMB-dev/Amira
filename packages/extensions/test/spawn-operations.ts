import { test } from "bun:test"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../scripts/spawn-test.ts"
import {
  installPackage as install,
  restorePackages as restore,
  updatePackages as update,
} from "../src/index.ts"

/** An explicit per-test timeout without mutating Bun's process-wide default. */
export function spawnTest(name: string, body: () => void | Promise<void>) {
  test(name, body, SPAWN_TEST_TIMEOUT_MS)
}

/** Abort production helpers on test failure, then await their process/lock cleanup. */
export function spawnOperations() {
  const pending = new Set<Promise<unknown>>()
  let abort = new AbortController()
  return {
    start() {
      if (pending.size) throw new Error("previous package operations are still running")
      abort = new AbortController()
    },
    run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      abort.signal.throwIfAborted()
      const result = operation(abort.signal)
      pending.add(result)
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      )
      return result
    },
    async stop() {
      abort.abort()
      await waitForSpawnCondition("package operation cleanup", () => pending.size === 0)
    },
  }
}

export function packageOperations() {
  const operations = spawnOperations()
  const signalFor = (signal: AbortSignal, original?: AbortSignal) =>
    original ? AbortSignal.any([original, signal]) : signal
  const installPackage: typeof install = (spec, opts) =>
    operations.run((signal) => install(spec, { ...opts, signal: signalFor(signal, opts.signal) }))
  const restorePackages: typeof restore = (opts, each) =>
    operations.run((signal) => restore({ ...opts, signal: signalFor(signal, opts.signal) }, each))
  const updatePackages: typeof update = (opts, names, each) =>
    operations.run((signal) => update({ ...opts, signal: signalFor(signal, opts.signal) }, names, each))
  return { installPackage, restorePackages, updatePackages, start: operations.start, stop: operations.stop }
}
