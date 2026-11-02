import { expect, test } from "bun:test"
import { createWorkspaceReader, VIEWER_LONG_READ_LIMIT } from "../../src/server/reader.ts"

function fixture() {
  const lifetime = new AbortController()
  const pending: { op: string; signal: AbortSignal; resolve(value: unknown): void; owner?: object }[] = []
  const tracked: Promise<unknown>[] = []
  const call = (op: string, signal: AbortSignal, owner?: object) =>
    new Promise<never>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      pending.push({ op, signal, resolve: resolve as (value: unknown) => void, owner })
    })
  const reader = createWorkspaceReader({
    view: {
      identity: { sessionId: "s", sessionGeneration: 3 } as never,
      snapshot: {} as never,
      pendingRequests: [],
      supportedOperations: ["state.read"],
    },
    lifetime: lifetime.signal,
    execute: (op, _params, options) => call(op, options.signal!),
    request: (op, _params, options) => call(op, options.signal!, options.owner),
    track: (read) => {
      read.catch(() => {})
      tracked.push(read)
    },
  })
  return { reader, lifetime, pending, tracked }
}

test("a reader refuses controller-only operations before running anything", async () => {
  const f = fixture()
  for (const op of [
    "turn.prompt",
    "turn.abort",
    "ui.respond",
    "files.list",
    "commands.complete",
    "form.evaluate",
  ])
    await expect(f.reader.request(op as never, {} as never)).rejects.toMatchObject({ code: "not_controller" })
  await expect(f.reader.execute("turn.abort", {} as never)).rejects.toMatchObject({ code: "not_controller" })
  expect(f.pending).toHaveLength(0)
  expect(f.reader.identity?.sessionGeneration).toBe(3)
})

test("viewer long reads are bounded per reader and free their slot when they settle", async () => {
  const f = fixture()
  const reads = Array.from({ length: VIEWER_LONG_READ_LIMIT }, (_, index) =>
    f.reader.request(index % 2 ? "jobs.wait" : "conversations.history", {} as never),
  )
  await expect(f.reader.request("jobs.output", {} as never)).rejects.toMatchObject({ code: "limit_exceeded" })
  // Short reads are not long reads.
  const short = f.reader.request("jobs.list", {} as never).catch(() => {})
  expect(f.pending).toHaveLength(VIEWER_LONG_READ_LIMIT + 1)
  f.pending[0]!.resolve({ ok: true })
  await reads[0]
  const later = f.reader.request("jobs.output", {} as never).catch(() => {})
  expect(f.pending).toHaveLength(VIEWER_LONG_READ_LIMIT + 2)
  // Each reader owns its history scope and reports every read for draining.
  expect(f.pending[0]!.owner).toBeDefined()
  expect(f.pending.every((item) => item.owner === f.pending[0]!.owner)).toBe(true)
  expect(f.tracked).toHaveLength(f.pending.length)
  for (const read of reads.slice(1)) read.catch(() => {})
  f.reader.close()
  await Promise.all([short, later])
})

test("close aborts the reader's reads and refuses later ones; runtime stop does too", async () => {
  const f = fixture()
  const read = f.reader.execute("state.read", {})
  const caller = new AbortController()
  const own = f.reader.request("status.read", {}, { signal: caller.signal })
  caller.abort()
  await expect(own).rejects.toThrow("aborted")
  expect(f.pending[0]!.signal.aborted).toBe(false)
  f.reader.close()
  await expect(read).rejects.toThrow("aborted")
  await expect(f.reader.request("status.read", {})).rejects.toMatchObject({ code: "disconnected" })
  const g = fixture()
  const pending = g.reader.request("jobs.list", {} as never)
  g.lifetime.abort()
  await expect(pending).rejects.toThrow("aborted")
  await expect(g.reader.request("jobs.list", {} as never)).rejects.toMatchObject({ code: "disconnected" })
})
