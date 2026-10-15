import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
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
  const stat = spyOn(fs, "statSync")
  const rename = spyOn(fs, "renameSync")
  const write = spyOn(fs, "writeSync")
  const stringify = spyOn(JSON, "stringify")
  try {
    for (let i = 0; i < 5; i++) store.appendMessage(message)
    expect(historyReads).toBe(0)
    expect(read).not.toHaveBeenCalled()
    expect(tail).toHaveBeenCalledTimes(5)
    for (const length of lengths) expect(length).toBeLessThanOrEqual(4096)
    expect(append).toHaveBeenCalledTimes(5)
    // Canonical identity, generation validation, size check, and post-append generation.
    expect(stat.mock.calls.filter(([file]) => file === store.file)).toHaveLength(20)
    // A held writer must not republish a gate or rewrite its lease per append.
    expect(rename).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
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
    stat.mockRestore()
    rename.mockRestore()
    write.mockRestore()
    stringify.mockRestore()
    for (let index = 0; index < descriptors.length; index++) {
      Object.defineProperty(history, String(index), descriptors[index]!)
    }
  }
}

test("held-lease append work does not grow with session history", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-append-perf-"))
  const small = seeded(dir, 100)
  const large = seeded(dir, 3000)
  try {
    expect(small.claim()).toBe(true)
    expect(large.claim()).toBe(true)
    boundedAppends(small)
    boundedAppends(large)
  } finally {
    small.release()
    large.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("persisted sub-agent appends use the same bounded work as held-lease appends", async () => {
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
    boundedAppends(held)
    boundedAppends(store)
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

test("200 new sessions use one transient gate and one append each, without persistent leases", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-create-perf-"))
  const canonicalDir = fs.realpathSync(dir)
  const rename = spyOn(fs, "renameSync")
  const write = spyOn(fs, "writeSync")
  const append = spyOn(fs, "appendFileSync")
  try {
    // Work counts catch extra locking/persistence without comparing noisy disk timings.
    for (let i = 0; i < 200; i++) SessionStore.create({ cwd: dir, dir }).appendMessage(message)
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
  }
}, 15_000)
