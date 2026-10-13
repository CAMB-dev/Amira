import { expect, test } from "bun:test"
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

test("held-lease append cost does not grow with session history", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-append-perf-"))
  const small = seeded(dir, 100)
  const large = seeded(dir, 3000)
  try {
    small.claim()
    large.claim()
    for (let i = 0; i < 10; i++) {
      small.appendMessage(message)
      large.appendMessage(message)
    }
    // Alternate equal batches to share JIT, filesystem and parallel-runner load.
    const elapsed = [0, 0]
    for (let round = 0; round < 10; round++) {
      for (const index of round % 2 ? [1, 0] : [0, 1]) {
        const store = index === 0 ? small : large
        const start = performance.now()
        for (let i = 0; i < 10; i++) store.appendMessage(message)
        elapsed[index]! += performance.now() - start
      }
    }
    console.log(
      `held append: 100=${(elapsed[0]! / 100).toFixed(3)}ms, 3000=${(elapsed[1]! / 100).toFixed(3)}ms`,
    )
    expect(elapsed[1]! / elapsed[0]!).toBeLessThan(2)
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
    held.claim()
    const child = tree.spawn(parent, { prompt: "work" })
    const store = tree.subagent(child.id)!.session!
    expect(existsSync(store.file)).toBe(false)
    expect(existsSync(sessionLockFile(store.file))).toBe(false)
    await opened.promise
    for (let i = 0; i < 10; i++) {
      held.appendMessage(message)
      store.appendMessage(message)
    }
    const elapsed = [0, 0]
    for (let round = 0; round < 10; round++) {
      for (const index of round % 2 ? [1, 0] : [0, 1]) {
        const target = index === 0 ? held : store
        const start = performance.now()
        for (let i = 0; i < 10; i++) target.appendMessage(message)
        elapsed[index]! += performance.now() - start
      }
    }
    console.log(
      `child append: held=${(elapsed[0]! / 100).toFixed(3)}ms, child=${(elapsed[1]! / 100).toFixed(3)}ms`,
    )
    expect(elapsed[1]! / elapsed[0]!).toBeLessThan(2)
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

test("creating and appending to 200 sessions stays well below the default timeout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-create-perf-"))
  try {
    const start = performance.now()
    for (let i = 0; i < 200; i++) SessionStore.create({ cwd: dir, dir }).appendMessage(message)
    const elapsed = performance.now() - start
    console.log(`200 create+append: ${elapsed.toFixed(1)}ms`)
    // Leave 1.5 seconds of the default timeout for parallel CI contention and cleanup.
    expect(elapsed).toBeLessThan(3500)
    expect(readdirSync(dir)).toHaveLength(200)
    expect(readdirSync(dir).every((file) => file.endsWith(".jsonl"))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
