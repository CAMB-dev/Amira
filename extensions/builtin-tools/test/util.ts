import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@amira/api"
import { SPAWN_WAIT_TIMEOUT_MS, stopSpawn, waitForSpawnCondition } from "../../../scripts/spawn-test.ts"

/** Bound production helpers that own their processes but do not expose a Subprocess. */
export async function waitForSpawnWork<T>(
  label: string,
  work: Promise<T>,
  timeoutMs = SPAWN_WAIT_TIMEOUT_MS,
): Promise<T> {
  let settled = false
  const result = work.finally(() => {
    settled = true
  })
  void result.catch(() => {})
  await waitForSpawnCondition(label, () => settled, timeoutMs)
  return result
}

/** Abort and drain operations whose production runner owns the underlying process tree. */
export function spawnWorkScope(label: string) {
  const pending = new Map<Promise<unknown>, AbortController>()
  const children = new Set<Parameters<typeof stopSpawn>[0]>()
  let aborting = false
  const abort = () => {
    aborting = true
    for (const controller of pending.values()) controller.abort()
  }
  return {
    own<T extends Parameters<typeof stopSpawn>[0]>(child: T): T {
      children.add(child)
      return child
    },
    run<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const controller = new AbortController()
      if (aborting) controller.abort()
      const work = run(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      pending.set(work, controller)
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      )
      return work
    },
    abort,
    async cleanup() {
      abort()
      try {
        await cleanupSpawnWork(label, [
          () => waitForSpawnCondition(label, () => pending.size === 0),
          ...[...children].map((child) => () => stopSpawn(child, label)),
        ])
      } finally {
        children.clear()
        aborting = false
      }
    },
  }
}

/** Attempt every teardown even when one fails, with one shared cleanup deadline. */
export async function cleanupSpawnWork(label: string, cleanup: (() => unknown)[]) {
  const results = await waitForSpawnWork(
    label,
    Promise.allSettled(cleanup.map((close) => Promise.resolve().then(close))),
  )
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, label)
}

export function makeCtx(
  cwd: string,
  signal = new AbortController().signal,
): ToolContext & { updates: ToolResult[] } {
  const updates: ToolResult[] = []
  return { cwd, toolCallId: "call-1", signal, updates, update: (p) => void updates.push(p) }
}

export function textOf(r: ToolResult): string {
  return r.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("")
}

/** Drain timed-out async tests before teardown; Bun otherwise reports their late rejections globally. */
export function asyncTestScope() {
  const pending = new Set<Promise<void>>()
  let controller = new AbortController()
  return {
    run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
      const signal = controller.signal
      const result = work(signal).catch((error) => {
        // After teardown starts, the runner has already recorded the timeout.
        if (!signal.aborted) throw error
      })
      pending.add(result)
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      )
      return result
    },
    async cleanup() {
      const current = controller
      controller = new AbortController()
      current.abort()
      await Promise.allSettled([...pending])
    },
  }
}

/** Creates temp dirs and removes them all in `cleanup`. */
export function tempDirs() {
  const dirs: string[] = []
  return {
    async make(prefix = "amira-tools-"): Promise<string> {
      const d = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(d)
      return d
    },
    async cleanup() {
      for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
    },
  }
}
