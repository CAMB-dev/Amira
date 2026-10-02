import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { TraceRecord } from "@amira/api"
import { SessionStore } from "@amira/core"
import type { ControlTrace } from "../src/control/context.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

async function setup(trace?: ControlTrace) {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-control-"))
  const store = SessionStore.create({ cwd: dir, dir })
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const session = await createSession({
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: true,
    ai,
    store,
  })
  const host = createCommandHost({ session, cwd: dir, ...(trace ? { trace } : {}) })
  return { dir, store, session, host }
}

function savedTrace(store: SessionStore) {
  const record: TraceRecord = { type: "trace", v: 1, sessionId: store.id, startedAt: 10 }
  writeFileSync(`${store.file}.trace.jsonl`, `${JSON.stringify(record)}\n`)
  return record
}

test("trace defaults to current session, includes stored descendants and excludes unrelated ids", async () => {
  const { dir, store, session, host } = await setup()
  try {
    expect(await host.control.trace()).toEqual([])
    store.appendMessage(userMessage("root"))
    const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
    child.appendMessage(userMessage("child"))
    store.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
    const grandchild = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents", "subagents") })
    grandchild.appendMessage(userMessage("grandchild"))
    child.append({ type: "subagent", childSessionId: grandchild.id, role: "explorer" })
    const unrelated = SessionStore.create({ cwd: dir, dir })
    unrelated.appendMessage(userMessage("unrelated"))
    savedTrace(unrelated)
    const records = [store, child, grandchild].map(savedTrace)
    expect(await host.control.trace()).toEqual([records[0]!])
    expect(await host.control.trace(store.id)).toEqual([records[0]!])
    expect(await host.control.trace(child.id)).toEqual([records[1]!])
    expect(await host.control.trace(grandchild.id)).toEqual([records[2]!])
    expect(await host.control.trace(unrelated.id)).toEqual([])
    expect(await host.control.trace("../../outside")).toEqual([])
  } finally {
    await session.agent.dispose("exit")
    await session.agent.bus.flush()
    await session.traceRecorder?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("trace snapshots use recorder I/O without draining the event bus", async () => {
  const reads: string[] = []
  const record = { type: "status" as const, at: 10, status: "idle" as const }
  const { dir, store, session, host } = await setup({
    read: async (file) => {
      reads.push(file)
      return [record]
    },
    forget: async () => {},
  })
  try {
    let snapshot: unknown
    session.agent.bus.subscribe(async (event) => {
      if (event.type === "session.title") snapshot = await host.control.trace()
    })
    session.agent.bus.emit("session.title", { title: "test" }, { sessionId: store.id })
    await session.agent.bus.flush()
    expect(snapshot).toEqual([record])
    expect(reads).toEqual([store.file])
    expect(await host.control.trace("unrelated")).toEqual([])
    expect(reads).toHaveLength(1)
  } finally {
    await session.agent.dispose("exit")
    await session.agent.bus.flush()
    await session.traceRecorder?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("delete retires only owned recorder ids and removes an append that finished during deletion", async () => {
  const forgotten: string[][] = []
  let lateFile: string | undefined
  const { dir, store, session, host } = await setup({
    read: async () => [],
    forget: async (ids) => {
      forgotten.push(ids)
      if (lateFile) writeFileSync(`${lateFile}.trace.jsonl`, "late append\n")
    },
  })
  try {
    store.appendMessage(userMessage("current"))
    const other = SessionStore.create({ cwd: dir, dir })
    other.appendMessage(userMessage("other"))
    const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
    child.appendMessage(userMessage("shared child"))
    other.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
    const fork = other.fork()
    savedTrace(other)
    savedTrace(child)
    lateFile = other.file
    await host.control.deleteSession!(other.id)
    expect(forgotten).toEqual([[other.id]])
    expect(existsSync(`${other.file}.trace.jsonl`)).toBe(false)
    expect(existsSync(`${child.file}.trace.jsonl`)).toBe(true)
    lateFile = child.file
    await host.control.deleteSession!(fork.id)
    expect(forgotten[1]).toEqual([fork.id, child.id])
    expect(existsSync(`${child.file}.trace.jsonl`)).toBe(false)
  } finally {
    await session.agent.dispose("exit")
    await session.agent.bus.flush()
    await session.traceRecorder?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
