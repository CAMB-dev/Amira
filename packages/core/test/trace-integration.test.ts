import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { type AnyEvent, defineTool, summarizeTrace, textResult } from "@amira/api"
import { Agent, type ApprovalDecision } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { TraceRecorder } from "../src/trace.ts"

test("a stored mock run records parent and child, retries, parallel tools, compaction and an approval abort", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-integration-"))
  const mock = createMockDialect([
    { error: { message: "HTTP 429: slow", status: 429, retryable: true } },
    { toolCalls: ["ok", "error", "denied"].map((kind) => ({ id: kind, name: "work", args: { kind } })) },
    { text: "done", usage: { input: 20, output: 5 } },
    { text: "child done", usage: { input: 10, output: 3 } },
    { text: "another turn" },
    { toolCalls: [{ id: "aborted", name: "work", args: { kind: "aborted" } }] },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
    retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const recorder = new TraceRecorder(bus)
  const store = SessionStore.create({ cwd: dir, dir })
  recorder.register(store.id, store.file)
  const tree = new AgentTree({ ai })
  const waiting = Promise.withResolvers<void>()
  const decision = Promise.withResolvers<ApprovalDecision>()
  const agent = new Agent({
    ai,
    bus,
    tree,
    session: store,
    cwd: dir,
    model: ai.model("mock/test"),
    systemPrompt: "test",
    compaction: { auto: false },
    abortGraceMs: 1,
    approve: async (request) => {
      if (request.args.kind === "aborted") {
        waiting.resolve()
        return decision.promise
      }
      await Bun.sleep(5)
      return { approved: false }
    },
  })
  agent.tools.register(
    defineTool<{ kind: string }>({
      name: "work",
      description: "fake work",
      concurrency: "parallel",
      traits: { readOnly: true },
      parameters: { type: "object", properties: { kind: { type: "string" } } },
      execute: async ({ kind }) => {
        await Bun.sleep(10)
        return textResult(kind, kind === "error")
      },
    }),
    "test",
  )
  agent.interceptors.add("tool.call.before", (call) =>
    ["denied", "aborted"].includes(String(call.args.kind))
      ? { action: "ask", reason: "approve test call" }
      : { action: "pass" },
  )
  try {
    agent.start("startup")
    expect((await agent.prompt("run tools")).reason).toBe("done")
    const child = tree.spawn(agent, { prompt: "child task", role: "explorer", title: "One child" })
    expect((await child.result()).status).toBe("done")
    await agent.prompt("second turn")
    agent.interceptors.add("compact.before", (value) => ({
      action: "modify",
      value: { ...value, summary: "brief" },
    }))
    expect(await agent.compact()).toBe(true)
    const aborted = agent.prompt("abort the approval")
    await waiting.promise
    agent.abort()
    expect((await aborted).reason).toBe("aborted")
    decision.resolve({ approved: true })
    await agent.dispose("exit")
    await bus.flush()
    const records = await recorder.read(store.file)
    const tools = records.filter((record) => record.type === "tool")
    expect(tools).toHaveLength(4)
    expect(Object.fromEntries(tools.map((tool) => [tool.toolCallId, tool.outcome]))).toEqual({
      ok: "ok",
      error: "error",
      denied: "denied",
      aborted: "aborted",
    })
    for (const tool of tools) {
      const start = events.find(
        (event) => event.type === "tool.execute.start" && event.data.toolCallId === tool.toolCallId,
      )!
      const end = events.find(
        (event) => event.type === "tool.execute.end" && event.data.toolCallId === tool.toolCallId,
      )!
      expect(tool.start).toBe(start.ts)
      expect(tool.end).toBe(end.ts)
      if (tool.outcome === "denied" || tool.outcome === "aborted")
        expect(tool.approvalWaitMs).toBeGreaterThanOrEqual(0)
      else expect(tool.approvalWaitMs).toBeUndefined()
    }
    const retry = events.find((event) => event.type === "model.retry")!
    const model = records.find((record) => record.type === "model" && record.retries?.length)
    expect(model).toMatchObject({ retries: [{ at: retry.ts, delayMs: 1, kind: "rate" }] })
    // withRetry only sends again before any content, so a failed attempt emits no delta and the
    // first token belongs to the attempt that succeeded.
    const first = events.find((event) => event.type === "message.start")!
    expect(
      events.filter(
        (event) => event.type === "message.delta" && event.seq > first.seq && event.seq < retry.seq,
      ),
    ).toEqual([])
    expect(model?.type === "model" && model.firstToken).toBeGreaterThanOrEqual(retry.ts)
    const compact = records.find((record) => record.type === "compact")
    expect(compact).toMatchObject({
      reason: "manual",
      start: events.find((event) => event.type === "compact.start")!.ts,
      end: events.find((event) => event.type === "compact.end")!.ts,
    })
    const childRecords = await recorder.read(path.join(dir, "subagents", `${child.id}.jsonl`))
    expect(childRecords[0]).toMatchObject({
      type: "trace",
      parentSessionId: store.id,
      role: "explorer",
      title: "One child",
    })
    expect(childRecords.filter((record) => record.type === "turn")).toHaveLength(1)
    expect(records.find((record) => record.type === "subagent")).toMatchObject({
      childSessionId: child.id,
      start: events.find((event) => event.type === "session.start" && event.sessionId === child.id)!.ts,
      end: events.find((event) => event.type === "subagent.end")!.ts,
    })
    const summary = summarizeTrace(records)
    expect(summary.retries).toBe(1)
    expect(summary.failures).toHaveLength(4)
    expect(summary.tools.work?.count).toBe(4)
    expect(summary.subagentUsage.input).toBe(10)
  } finally {
    decision.resolve({ approved: false })
    await agent.dispose("exit")
    await bus.flush()
    await recorder.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test("quitting while a tool waits on approval still records the interrupted call and turn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-quit-"))
  const mock = createMockDialect([{ toolCalls: [{ id: "asked", name: "work", args: {} }] }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
  })
  const bus = new EventBus()
  const recorder = new TraceRecorder(bus)
  const store = SessionStore.create({ cwd: dir, dir })
  recorder.register(store.id, store.file)
  const waiting = Promise.withResolvers<void>()
  const agent = new Agent({
    ai,
    bus,
    session: store,
    cwd: dir,
    model: ai.model("mock/test"),
    systemPrompt: "test",
    compaction: { auto: false },
    abortGraceMs: 1,
    approve: (_request, signal) => {
      waiting.resolve()
      return new Promise((resolve) =>
        signal?.addEventListener("abort", () => resolve({ approved: false }), { once: true }),
      )
    },
  })
  agent.tools.register(
    defineTool({
      name: "work",
      description: "fake work",
      parameters: { type: "object", properties: {} },
      execute: async () => textResult("never"),
    }),
    "test",
  )
  agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approve test call" }))
  try {
    agent.start("startup")
    const turn = agent.prompt("run a tool")
    await waiting.promise
    // The user takes a while to answer: the one-second timer has written everything so far.
    await bus.flush()
    await recorder.flush()
    // No abort first: session.end comes before the turn unwinds.
    await agent.dispose("exit")
    await turn
    await bus.flush()
    const records = await recorder.read(store.file)
    expect(records.filter((record) => record.type === "tool").map((record) => record.outcome)).toEqual([
      "aborted",
    ])
    expect(records.filter((record) => record.type === "turn").map((record) => record.reason)).toEqual([
      "aborted",
    ])
  } finally {
    await agent.dispose("exit")
    await bus.flush()
    await recorder.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
