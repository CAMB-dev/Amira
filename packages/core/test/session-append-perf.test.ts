import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

const message = userMessage("x".repeat(2048))

function seeded(dir: string, count: number): SessionStore {
  const store = SessionStore.create({ cwd: dir, dir })
  const entries = Array.from({ length: count }, (_, i) =>
    JSON.stringify({ type: "message", message, id: `e_${i}`, parentId: i ? `e_${i - 1}` : null, ts: i }),
  )
  writeFileSync(store.file, `${JSON.stringify(store.header)}\n${entries.join("\n")}\n`)
  return SessionStore.open(store.file)
}

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!

/** Catch O(history) disk/serialization work independently of machine speed. */
function boundedAppends(store: SessionStore) {
  // Guard indexed reads as well as iteration/serialization: even a cheap history
  // walk can hide underneath filesystem latency in a small-vs-large timing ratio.
  const history = store.entries
  const descriptors = Array.from(
    { length: history.length },
    (_, index) => Object.getOwnPropertyDescriptor(history, String(index))!,
  )
  let historyReads = 0
  for (let index = 0; index < descriptors.length; index++) {
    Object.defineProperty(history, String(index), {
      configurable: true,
      enumerable: true,
      get: () => {
        historyReads++
        return descriptors[index]!.value
      },
    })
  }
  const read = spyOn(fs, "readFileSync")
  const readTail = fs.readSync
  const lengths: number[] = []
  const tail = spyOn(fs, "readSync").mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    lengths.push(length)
    return readTail(fd, buffer, offset, length, position)
  }) as typeof readTail)
  const append = spyOn(fs, "appendFileSync")
  const stringify = spyOn(JSON, "stringify")
  try {
    for (let i = 0; i < 5; i++) store.appendMessage(message)
    expect(historyReads).toBe(0)
    expect(read).not.toHaveBeenCalled()
    expect(tail).toHaveBeenCalledTimes(5)
    for (const length of lengths) expect(length).toBeLessThanOrEqual(4096)
    expect(append).toHaveBeenCalledTimes(5)
    for (const [file, text] of append.mock.calls) {
      expect(file).toBe(store.file)
      expect(Buffer.byteLength(String(text))).toBeLessThan(8192)
    }
    // A history rewrite in memory is also O(n), even if the filesystem stays bounded.
    const serialized = stringify.mock.results.filter((result) => result.type === "return")
    expect(serialized.every((result) => String(result.value).length < 8192)).toBe(true)
  } finally {
    read.mockRestore()
    tail.mockRestore()
    append.mockRestore()
    stringify.mockRestore()
    for (let index = 0; index < descriptors.length; index++) {
      Object.defineProperty(history, String(index), descriptors[index]!)
    }
  }
}

function appendSamples(first: SessionStore, second: SessionStore): [number[], number[]] {
  for (let i = 0; i < 10; i++) {
    first.appendMessage(message)
    second.appendMessage(message)
  }
  const samples: [number[], number[]] = [[], []]
  // Alternate warmed batches; medians reject isolated scheduler/filesystem pauses.
  for (let round = 0; round < 10; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const store = index === 0 ? first : second
      const start = performance.now()
      for (let i = 0; i < 10; i++) store.appendMessage(message)
      samples[index]!.push((performance.now() - start) / 10)
    }
  }
  return samples
}

test("held-lease append cost does not grow with session history", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-append-perf-"))
  const small = seeded(dir, 100)
  const large = seeded(dir, 3000)
  try {
    expect(small.claim()).toBe(true)
    expect(large.claim()).toBe(true)
    const [smallSamples, largeSamples] = appendSamples(small, large)
    boundedAppends(small)
    boundedAppends(large)
    const smallMs = median(smallSamples)
    const largeMs = median(largeSamples)
    console.log(`held append medians: 100=${smallMs.toFixed(3)}ms, 3000=${largeMs.toFixed(3)}ms`)
    expect(largeMs / smallMs).toBeLessThan(2)
    // Ratios alone would allow both paths to regress to seconds per append.
    expect(smallMs).toBeLessThan(35)
    expect(largeMs).toBeLessThan(35)
  } finally {
    small.release()
    large.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("persisted sub-agent appends cost within 2x of held-lease appends", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-child-append-perf-"))
  const opened = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const ai = createAi({
    dialects: [
      createMockDialect([
        () => {
          opened.resolve()
          return { text: "done", hold: { chunks: 0, until: release.promise } }
        },
      ]),
    ],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const parent = new Agent({
    ai,
    tree,
    model: ai.model("mock/m"),
    cwd: dir,
    session: SessionStore.create({ cwd: dir, dir }),
    sections: [],
  })
  const held = seeded(dir, 100)
  try {
    expect(held.claim()).toBe(true)
    const child = tree.spawn(parent, { prompt: "work" })
    const store = tree.subagent(child.id)!.session!
    expect(existsSync(store.file)).toBe(false)
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
    await opened.promise
    const [heldSamples, childSamples] = appendSamples(held, store)
    boundedAppends(held)
    boundedAppends(store)
    const heldMs = median(heldSamples)
    const childMs = median(childSamples)
    console.log(`child append medians: held=${heldMs.toFixed(3)}ms, child=${childMs.toFixed(3)}ms`)
    expect(childMs / heldMs).toBeLessThan(2)
    expect(heldMs).toBeLessThan(35)
    expect(childMs).toBeLessThan(35)
    expect(existsSync(sessionLockFile(store.file))).toBe(true)
    release.resolve()
    expect((await child.result()).status).toBe("done")
    await tree.waitForChildren()
    expect(readdirSync(path.dirname(store.file))).toEqual([path.basename(store.file)])
  } finally {
    release.resolve()
    await parent.dispose()
    held.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("200 new sessions use one transient gate each and stay near the filesystem baseline", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-create-perf-"))
  const baselineDir = mkdtempSync(path.join(tmpdir(), "amira-create-baseline-"))
  const canonicalDir = fs.realpathSync(dir)
  const text = `${JSON.stringify({ type: "message", message })}\n`
  let nextBaseline = 0
  const baseline = () => {
    const file = path.join(baselineDir, `${nextBaseline++}.jsonl`)
    const unlock = takeFilesystemGate(sessionLockFile(file))!
    expect(unlock).toBeDefined()
    try {
      fs.appendFileSync(file, text)
    } finally {
      unlock()
    }
  }
  const rename = spyOn(fs, "renameSync")
  const write = spyOn(fs, "writeSync")
  const append = spyOn(fs, "appendFileSync")
  try {
    // Warm both real paths outside the measured directory and operation counts.
    baseline()
    SessionStore.create({ cwd: baselineDir, dir: baselineDir }).appendMessage(message)
    rename.mockClear()
    write.mockClear()
    append.mockClear()
    const samples: number[] = []
    const baselines: number[] = []
    for (let round = 0; round < 20; round++) {
      const runBaseline = () => {
        const start = performance.now()
        for (let i = 0; i < 2; i++) baseline()
        baselines.push((performance.now() - start) / 2)
      }
      if (round % 2 === 0) runBaseline()
      const start = performance.now()
      for (let i = 0; i < 10; i++) SessionStore.create({ cwd: dir, dir }).appendMessage(message)
      samples.push((performance.now() - start) / 10)
      if (round % 2 === 1) runBaseline()
    }
    const createMs = median(samples)
    const baselineMs = median(baselines)
    console.log(
      `create+append medians: session=${createMs.toFixed(2)}ms, gate+write=${baselineMs.toFixed(2)}ms`,
    )
    expect(createMs / baselineMs).toBeLessThan(2)
    // Preserve the original 3.5s budget on the best warmed batch, excluding isolated
    // filesystem/scheduler pauses; operation counts and the median ratio stay strict.
    expect(Math.min(...samples) * 200).toBeLessThan(3500)
    // A persistent lease publishes and releases through extra gates and writes a lease
    // descriptor. Count those operations instead of relying on the speed of CI's disk.
    expect(
      rename.mock.calls.filter(
        ([, target]) =>
          path.dirname(String(target)) === canonicalDir && String(target).endsWith(".lease-gate"),
      ),
    ).toHaveLength(200)
    expect(write).not.toHaveBeenCalled()
    expect(append.mock.calls.filter(([file]) => path.dirname(String(file)) === canonicalDir)).toHaveLength(
      200,
    )
    expect(readdirSync(dir)).toHaveLength(200)
    expect(readdirSync(dir).every((file) => file.endsWith(".jsonl"))).toBe(true)
  } finally {
    rename.mockRestore()
    write.mockRestore()
    append.mockRestore()
    rmSync(dir, { recursive: true, force: true })
    rmSync(baselineDir, { recursive: true, force: true })
  }
  // Additional baseline work is outside the performance assertion, not timeout headroom.
}, 15_000)
