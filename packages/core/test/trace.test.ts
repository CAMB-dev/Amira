import { afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { type AnyEvent, type EventMap, emptyUsage, type TraceRecord, textResult } from "@amira/api"
import { type EmitMeta, EventBus } from "../src/event-bus.ts"
import { TraceRecorder } from "../src/trace.ts"
import { TraceFile } from "../src/trace-file.ts"

const model = { provider: "mock", model: "test" }
const usage = { ...emptyUsage(), input: 20, output: 10 }
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup(persist = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-"))
  const file = path.join(dir, "root.jsonl")
  if (persist) writeFileSync(file, "{}\n")
  const bus = new EventBus()
  const recorder = new TraceRecorder(bus)
  recorder.register("root", file)
  cleanups.push(async () => {
    await bus.flush()
    await recorder.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const emit = <K extends keyof EventMap>(
    type: K,
    ts: number,
    data: EventMap[K],
    meta: EmitMeta = { sessionId: "root", turnId: "turn" },
  ) => {
    const event = bus.emit(type, data, meta)
    event.ts = ts
    return event
  }
  const start = (ts = 1, reason: EventMap["session.start"]["reason"] = "startup") =>
    emit("session.start", ts, { reason, cwd: dir, model, title: "Root" })
  const read = async (target = file) => {
    await bus.flush()
    return recorder.read(target)
  }
  return { dir, file, bus, recorder, emit, start, read }
}

function records<T extends TraceRecord["type"]>(all: TraceRecord[], type: T) {
  return all.filter((record): record is Extract<TraceRecord, { type: T }> => record.type === type)
}

test("host diagnostics are trace-only and retain the header before early console drift", async () => {
  const { recorder, bus, start, read } = setup()
  const events: string[] = []
  const off = bus.subscribe((event) => void events.push(event.type))
  recorder.diagnostic("root", "Windows console output code page changed from 65001 to 936")
  start(100)
  const early = await read()
  expect(early.map((record) => record.type)).toEqual(["trace", "diagnostic"])
  recorder.diagnostic("root", "later host diagnostic")
  const all = await read()
  expect(records(all, "diagnostic")).toEqual([
    { type: "diagnostic", at: expect.any(Number), message: expect.stringContaining("936") },
    { type: "diagnostic", at: expect.any(Number), message: "later host diagnostic" },
  ])
  expect(events).toEqual(["session.start"])
  off()
})

test("late exit diagnostics are saved synchronously even after the trace exit flush", async () => {
  const { recorder, bus, start, file } = setup()
  start()
  await bus.flush()
  recorder.emergencyFlush()
  await recorder.close()
  recorder.diagnostic("root", "Windows console output code page changed from 65001 to 936")
  const saved = readFileSync(`${file}.trace.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(saved.map((record) => record.type)).toEqual(["trace", "diagnostic"])
  expect(saved[1].message).toContain("936")
})

test("empty text and structural thinking events do not change trace firstToken", async () => {
  const { start, emit, read } = setup()
  start(100)
  emit("message.start", 200, { model })
  emit("message.stream", 300, { kind: "thinkingStart", index: 0 })
  emit("message.delta", 350, { kind: "thinking", text: "" })
  emit("message.delta", 360, { kind: "text", text: "" })
  emit("message.stream", 400, { kind: "thinkingEnd", index: 0 })
  emit("message.end", 500, { message: { role: "assistant", model, content: [], usage } })
  emit("message.start", 600, { model })
  emit("message.stream", 700, { kind: "thinkingStart", index: 0 })
  emit("message.delta", 750, { kind: "thinking", text: "" })
  emit("message.stream", 900, { kind: "thinkingEnd", index: 0 })
  emit("message.delta", 1000, { kind: "text", text: "Answer." })
  emit("message.end", 1200, { message: { role: "assistant", model, content: [], usage } })
  emit("message.start", 1300, { model })
  emit("message.stream", 1400, { kind: "thinkingStart", index: 0 })
  emit("message.delta", 1600, { kind: "thinking", text: "A visible summary." })
  emit("message.delta", 1700, { kind: "text", text: "Answer." })
  emit("message.end", 1800, { message: { role: "assistant", model, content: [], usage } })
  expect(records(await read(), "model").map((record) => record.firstToken)).toEqual([undefined, 1000, 1600])
})

test("maps a timestamped main run with retry, parallel dispositions and compaction", async () => {
  const { start, emit, read } = setup()
  start(100)
  emit("turn.start", 110, { prompt: { role: "user", content: [{ type: "text", text: "go" }] } })
  emit("status.changed", 111, { status: "working", reason: "turn" })
  emit("message.start", 120, { model })
  emit("model.retry", 125, { attempt: 1, maxRetries: 2, delayMs: 5, kind: "rate", error: "retry" })
  emit("message.delta", 135, { kind: "text", text: "hello" })
  emit("message.delta", 138, { kind: "text", text: " again" })
  emit("message.end", 140, {
    message: { role: "assistant", content: [], model, usage, stopReason: "toolUse" },
  })
  const ends: EventMap["tool.execute.end"][] = [
    {
      toolCallId: "ok",
      name: "run",
      result: textResult("yes"),
      durationMs: 25,
      approval: "user",
      waitedMs: 7,
    },
    { toolCallId: "error", name: "run", result: textResult("bad", true), durationMs: 23 },
    {
      toolCallId: "denied",
      name: "run",
      result: textResult("no"),
      durationMs: 0,
      rejected: "blocked",
      waitedMs: 9,
    },
    {
      toolCallId: "aborted",
      name: "run",
      result: textResult("stopped"),
      durationMs: 0,
      rejected: "aborted",
      waitedMs: 0,
    },
    {
      toolCallId: "invalid",
      name: "run",
      result: textResult("args"),
      durationMs: 0,
      rejected: "invalidArgs",
    },
    {
      toolCallId: "unknown",
      name: "run",
      result: textResult("name"),
      durationMs: 0,
      rejected: "unknownTool",
    },
  ]
  for (const [index, end] of ends.entries()) {
    emit("tool.execute.start", 150 + index, {
      toolCallId: end.toolCallId,
      name: end.name,
      args: { n: index },
    })
  }
  emit("status.changed", 156, { status: "blocked", reason: "approval" })
  // Completion order differs from start order, just as parallel tools do.
  for (const [index, end] of ends.toReversed().entries()) emit("tool.execute.end", 170 + index, end)
  emit("compact.start", 180, { reason: "manual", replacing: 3, kept: 1, tokens: 100 })
  emit("compact.end", 190, {
    reason: "manual",
    replaced: 3,
    kept: 1,
    summary: "private summary",
    tokensAfter: 40,
    usage,
    native: model,
    fallback: "attempt failed",
  })
  emit("turn.end", 200, { reason: "done", steps: 2 })
  emit("status.changed", 201, { status: "idle" })
  const all = await read()
  expect(all[0]).toEqual({ type: "trace", v: 1, sessionId: "root", title: "Root", startedAt: 100 })
  expect(records(all, "model")).toEqual([
    {
      type: "model",
      turnId: "turn",
      model: "mock/test",
      start: 120,
      firstToken: 135,
      end: 140,
      usage,
      stopReason: "toolUse",
      retries: [{ at: 125, delayMs: 5, kind: "rate" }],
    },
  ])
  const tools = records(all, "tool")
  expect(tools.map((record) => record.outcome)).toEqual([
    "unknown-tool",
    "invalid",
    "aborted",
    "denied",
    "error",
    "ok",
  ])
  for (const [index, end] of ends.entries()) {
    const tool = tools.find((record) => record.toolCallId === end.toolCallId)!
    expect(tool.start).toBe(150 + index)
    expect(tool.end).toBe(175 - index)
    expect(tool.durationMs).toBe(end.durationMs)
    if (end.waitedMs === undefined) expect(tool).not.toHaveProperty("approvalWaitMs")
    else expect(tool.approvalWaitMs).toBe(end.waitedMs)
  }
  expect(tools.at(-1)?.approval).toBe("user")
  expect(records(all, "compact")).toEqual([
    {
      type: "compact",
      start: 180,
      end: 190,
      reason: "manual",
      tokensBefore: 100,
      tokensAfter: 40,
      usage,
      native: true,
      fallback: true,
    },
  ])
  expect(records(all, "turn")).toEqual([
    { type: "turn", turnId: "turn", start: 110, end: 200, reason: "done", steps: 2 },
  ])
  expect(records(all, "status").map(({ at, status }) => [at, status])).toEqual([
    [111, "working"],
    [156, "blocked"],
    [201, "idle"],
  ])
  expect(JSON.stringify(all)).not.toContain("private summary")
})

test("infers child and nested paths and records queue admission and cancelled queues", async () => {
  const { dir, file, start, emit, read } = setup()
  const childFile = path.join(dir, "subagents", "child.jsonl")
  const nestedFile = path.join(dir, "subagents", "subagents", "nested.jsonl")
  mkdirSync(path.dirname(nestedFile), { recursive: true })
  writeFileSync(childFile, "{}\n")
  writeFileSync(nestedFile, "{}\n")
  start(10)
  const child = { sessionId: "child", parentSessionId: "root", turnId: "child-turn" }
  const nested = { sessionId: "nested", parentSessionId: "child", turnId: "nested-turn" }
  const spawn = (childSessionId: string, queued: boolean): EventMap["subagent.start"] => ({
    childSessionId,
    role: "coder",
    title: "Child task",
    toolCallId: "spawn",
    groupId: "group",
    prompt: "private child prompt",
    model,
    depth: 1,
    cwd: dir,
    context: "fresh",
    queued,
  })
  emit("subagent.start", 20, spawn("child", true))
  emit("session.start", 30, { reason: "startup", cwd: dir, model }, child)
  emit("subagent.start", 35, spawn("nested", false), child)
  emit("session.start", 40, { reason: "startup", cwd: dir, model }, nested)
  emit("status.changed", 45, { status: "working" }, nested)
  emit("subagent.end", 50, { childSessionId: "nested", status: "done", durationMs: 10, usage }, child)
  emit("subagent.end", 60, { childSessionId: "child", status: "done", durationMs: 30, usage })
  emit("subagent.start", 70, spawn("cancelled", true))
  emit("subagent.end", 80, {
    childSessionId: "cancelled",
    status: "aborted",
    durationMs: 0,
    usage: emptyUsage(),
  })
  const root = await read(file)
  expect(
    records(root, "subagent").map(({ childSessionId, queuedAt, start, end }) => ({
      childSessionId,
      queuedAt,
      start,
      end,
    })),
  ).toEqual([
    { childSessionId: "child", queuedAt: 20, start: 30, end: 60 },
    { childSessionId: "cancelled", queuedAt: 70, start: 80, end: 80 },
  ])
  const childRecords = await read(childFile)
  expect(childRecords[0]).toEqual({
    type: "trace",
    v: 1,
    sessionId: "child",
    parentSessionId: "root",
    role: "coder",
    title: "Child task",
    startedAt: 30,
  })
  expect(records(childRecords, "subagent")[0]).toMatchObject({
    childSessionId: "nested",
    start: 40,
    end: 50,
    durationMs: 10,
    usage,
  })
  expect(records(childRecords, "subagent")[0]).not.toHaveProperty("queuedAt")
  expect((await read(nestedFile))[0]).toMatchObject({
    type: "trace",
    parentSessionId: "child",
    startedAt: 40,
  })
  expect(existsSync(path.join(dir, "subagents", "cancelled.jsonl.trace.jsonl"))).toBe(false)
  expect(JSON.stringify([...root, ...childRecords])).not.toContain("private child prompt")
})

test("bounds compact JSON and text previews by Unicode code points and records artifact IDs", async () => {
  const { start, emit, read } = setup()
  start()
  const args = { text: "😀漢".repeat(200), number: 2 }
  const text = `Shell: pwsh\n[Output saved as artifact a_deadbeef: 9,999 characters, 12 lines]\n${"🦊字".repeat(220)}`
  emit("tool.execute.start", 10, { toolCallId: "c", name: "write", args, writtenPaths: ["old.txt"] })
  emit("tool.execute.end", 20, {
    toolCallId: "c",
    name: "write",
    durationMs: 10,
    writtenPaths: ["new.txt"],
    result: {
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: "private-image" },
        { type: "text", text: "tail" },
      ],
      details: { secret: "private-details" },
    },
  })
  const all = await read()
  const tool = records(all, "tool")[0]!
  expect(tool.argsChars).toBe([...JSON.stringify(args)].length)
  expect(tool.argsPreview).toBe([...JSON.stringify(args)].slice(0, 300).join(""))
  expect(tool.resultChars).toBe([...`${text}\ntail`].length)
  expect([...tool.resultPreview]).toHaveLength(300)
  expect(tool.resultPreview).toBe([...text].slice(0, 300).join(""))
  expect(tool.artifact).toBe("a_deadbeef")
  expect(tool.writtenPaths).toEqual(["new.txt"])
  expect(JSON.stringify(all)).not.toContain("private-image")
  expect(JSON.stringify(all)).not.toContain("private-details")
})

test("pairs reused IDs FIFO without overwriting duplicate parallel starts", async () => {
  const { start, emit, read } = setup()
  start()
  for (const [ts, value] of [
    [10, "first"],
    [12, "second"],
  ] as const) {
    emit("tool.execute.start", ts, { toolCallId: "same", name: "echo", args: { value } })
  }
  emit("tool.execute.end", 20, {
    toolCallId: "same",
    name: "echo",
    result: textResult("one"),
    durationMs: 10,
  })
  emit("tool.execute.end", 25, {
    toolCallId: "same",
    name: "echo",
    result: textResult("two"),
    durationMs: 13,
  })
  emit("tool.execute.start", 30, { toolCallId: "same", name: "echo", args: { value: "third" } })
  emit("tool.execute.end", 40, {
    toolCallId: "same",
    name: "echo",
    result: textResult("three"),
    durationMs: 10,
  })
  expect(
    records(await read(), "tool").map(({ start, end, argsPreview }) => [start, end, argsPreview]),
  ).toEqual([
    [10, 20, '{"value":"first"}'],
    [12, 25, '{"value":"second"}'],
    [30, 40, '{"value":"third"}'],
  ])
})

test("records no-delta models, failed turns and failed compactions including unpaired failures", async () => {
  const { start, emit, read } = setup()
  start()
  emit("turn.start", 5, { prompt: { role: "user", content: [] } })
  emit("message.start", 10, { model })
  emit("message.end", 20, { message: { role: "assistant", content: [], model, stopReason: "error" } })
  emit("compact.start", 30, { reason: "threshold", replacing: 2, kept: 1, tokens: 90 })
  emit("compact.failed", 40, { error: "private server error" })
  emit("compact.failed", 50, { error: "blocked", blocked: true })
  emit("compact.failed", 60, { error: "empty", empty: true })
  emit("turn.end", 70, {
    reason: "error",
    steps: 1,
    failure: { kind: "auth", summary: "Key rejected", detail: "private provider detail" },
  })
  emit("turn.start", 80, { prompt: { role: "user", content: [] } }, { sessionId: "root", turnId: "other" })
  emit(
    "turn.end",
    90,
    { reason: "error", steps: 0, error: "request failed" },
    { sessionId: "root", turnId: "other" },
  )
  const all = await read()
  expect(records(all, "model")[0]).not.toHaveProperty("firstToken")
  expect(records(all, "compact")).toEqual([
    { type: "compact", start: 30, end: 40, reason: "failure:error", tokensBefore: 90 },
    { type: "compact", start: 50, end: 50, reason: "failure:blocked" },
    { type: "compact", start: 60, end: 60, reason: "failure:empty" },
  ])
  expect(records(all, "turn").map((record) => record.failure)).toEqual([
    { kind: "auth", message: "Key rejected" },
    { kind: "other", message: "request failed" },
  ])
  expect(JSON.stringify(all)).not.toContain("private")
})

test("appends another header on resume and accepts late completion after session.end", async () => {
  const { start, emit, read, bus, recorder, file } = setup()
  start(10)
  emit("turn.start", 20, { prompt: { role: "user", content: [] } })
  emit("tool.execute.start", 25, { toolCallId: "late", name: "echo", args: {} })
  emit("session.end", 30, { reason: "exit" })
  await bus.flush()
  await recorder.flush()
  emit("tool.execute.end", 40, {
    toolCallId: "late",
    name: "echo",
    result: textResult("late"),
    durationMs: 15,
  })
  emit("turn.end", 50, { reason: "aborted", steps: 1 })
  await read()
  const before = readFileSync(`${file}.trace.jsonl`, "utf8")
  // The host registers the stored session again when it resumes it (session.ts newAgent).
  recorder.register("root", file)
  start(100, "resume")
  emit("status.changed", 101, { status: "idle" })
  const all = await read()
  expect(records(all, "trace").map((record) => record.startedAt)).toEqual([10, 100])
  expect(records(all, "tool")[0]?.end).toBe(40)
  expect(records(all, "turn")[0]?.reason).toBe("aborted")
  expect(readFileSync(`${file}.trace.jsonl`, "utf8").startsWith(before)).toBe(true)
})

test("never writes ephemeral or still-lazy sessions, then flushes when the store persists", async () => {
  const { dir, file, start, emit, read, recorder, bus } = setup(false)
  start()
  emit("status.changed", 2, { status: "working" })
  emit("session.start", 3, { reason: "startup", cwd: dir, model }, { sessionId: "ephemeral" })
  emit("status.changed", 4, { status: "idle" }, { sessionId: "ephemeral" })
  await bus.flush()
  await recorder.flush()
  expect(readdirSync(dir)).toEqual([])
  expect(await read()).toEqual([])
  writeFileSync(file, "{}\n")
  expect((await read()).map((record) => record.type)).toEqual(["trace", "status"])
  expect(readdirSync(dir).sort()).toEqual(["root.jsonl", "root.jsonl.trace.jsonl"])
})

test("flushes by the one-second timer without a session end or explicit recorder drain", async () => {
  const { start, emit, bus, file } = setup()
  start()
  emit("status.changed", 2, { status: "working" })
  await bus.flush()
  // The extra scheduling margin is for CI filesystem latency, not a longer recorder interval.
  await Bun.sleep(1250)
  expect(readFileSync(`${file}.trace.jsonl`, "utf8").trim().split("\n")).toHaveLength(2)
}, 5000)

test("writer errors are isolated and reported only once per session", async () => {
  const { file, start, emit, bus, recorder } = setup()
  mkdirSync(`${file}.trace.jsonl`)
  const errors: AnyEvent[] = []
  bus.subscribe((event) => {
    if (event.type === "extension.error") errors.push(event)
  })
  start()
  emit("turn.start", 2, { prompt: { role: "user", content: [] } })
  emit("turn.end", 3, { reason: "done", steps: 1 })
  await bus.flush()
  await recorder.flush()
  await bus.flush()
  emit("status.changed", 4, { status: "idle" })
  await bus.flush()
  await recorder.flush()
  await bus.flush()
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatchObject({ type: "extension.error", sessionId: "root", data: { source: "trace" } })
})

test("forget waits for appends and ignores late events so deletion stays deleted", async () => {
  const { file, start, emit, bus, recorder, read } = setup()
  start()
  emit("status.changed", 2, { status: "working" })
  await bus.flush()
  const flushing = recorder.flush()
  await recorder.forget(["root"])
  await flushing
  rmSync(`${file}.trace.jsonl`, { force: true })
  // Keep the session file to prove retirement, rather than the missing-file guard, prevents writes.
  recorder.register("root", file)
  start(20, "resume")
  emit("status.changed", 21, { status: "idle" })
  await bus.flush()
  await recorder.flush()
  expect(existsSync(`${file}.trace.jsonl`)).toBe(false)
  expect(await read()).toEqual([])
})

test("a blocked writer does not hold the bus or prevent late records from being delivered", async () => {
  const { start, emit, bus, recorder, read } = setup()
  const original = TraceFile.prototype.flush
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const flush = spyOn(TraceFile.prototype, "flush").mockImplementation(function (this: TraceFile) {
    return blocked.then(() => original.call(this))
  })
  try {
    start()
    emit("session.end", 2, { reason: "exit" })
    emit("status.changed", 3, { status: "idle" })
    const drained = await Promise.race([bus.flush().then(() => true), Bun.sleep(200).then(() => false)])
    expect(drained).toBe(true)
    release()
    await recorder.flush()
    expect(records(await read(), "status")).toEqual([{ type: "status", at: 3, status: "idle" }])
  } finally {
    release()
    flush.mockRestore()
  }
})

test("a loss marker makes first-token timing unknown even if a later delta survives", async () => {
  const { start, emit, read } = setup()
  start()
  emit("message.start", 10, { model })
  emit("events.lost", 15, { dropped: 1 })
  emit("message.delta", 20, { kind: "text", text: "survived" })
  emit("message.end", 30, { message: { role: "assistant", content: [], model, stopReason: "end" } })
  const result = records(await read(), "model")[0]
  expect(result).toMatchObject({ start: 10, end: 30 })
  expect(result).not.toHaveProperty("firstToken")
})

// This must be a real process.exit, not a mock. Waiting for this native child under
// parallel Windows load has exceeded 10 s; allow startup and the emergency hook to finish.
test("process.exit emergency hook saves delivered records without an async flush", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-exit-"))
  cleanups.push(async () => {
    rmSync(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, "session.jsonl")
  writeFileSync(file, "{}\n")
  const busModule = pathToFileURL(path.resolve(import.meta.dir, "../src/event-bus.ts")).href
  const recorderModule = pathToFileURL(path.resolve(import.meta.dir, "../src/trace.ts")).href
  const script = `
    import { EventBus } from ${JSON.stringify(busModule)};
    import { TraceRecorder } from ${JSON.stringify(recorderModule)};
    const bus = new EventBus();
    const recorder = new TraceRecorder(bus);
    recorder.register("exit", ${JSON.stringify(file)});
    bus.emit("session.start", { reason: "startup", cwd: ${JSON.stringify(dir)}, model: { provider: "mock", model: "test" } }, { sessionId: "exit" });
    bus.emit("status.changed", { status: "idle" }, { sessionId: "exit" });
    await bus.flush();
    process.exit(0);
  `
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...process.env, AMIRA_HOME: path.join(dir, "home") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  const lines = readFileSync(`${file}.trace.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(lines.map((record) => record.type)).toEqual(["trace", "status"])
  expect(lines[0].sessionId).toBe("exit")
}, 30_000)

test("opening a session without activity writes no trace file", async () => {
  const { start, recorder, file, bus } = setup()
  start(100)
  await bus.flush()
  await recorder.flush()
  expect(existsSync(`${file}.trace.jsonl`)).toBe(false)
})

test("session.end while a turn waits on approval keeps its late records, then releases the session", async () => {
  const { start, emit, read, bus, recorder } = setup()
  start(10)
  emit("turn.start", 20, { prompt: { role: "user", content: [] } })
  // No model call or tool is in flight: the turn waits on an approval when the session ends.
  emit("session.end", 30, { reason: "exit" })
  await bus.flush()
  await recorder.flush()
  await Bun.sleep(5)
  emit("tool.execute.start", 40, { toolCallId: "asked", name: "echo", args: {} })
  emit("tool.execute.end", 40, {
    toolCallId: "asked",
    name: "echo",
    result: textResult("aborted", true),
    durationMs: 0,
    rejected: "aborted",
  })
  emit("turn.end", 50, { reason: "aborted", steps: 1 })
  await read()
  await Bun.sleep(5)
  // Released once idle: a stray event of the ended session is not recorded.
  emit("status.changed", 60, { status: "idle" })
  const all = await read()
  expect(records(all, "tool").map((record) => record.outcome)).toEqual(["aborted"])
  expect(records(all, "turn").map((record) => record.reason)).toEqual(["aborted"])
  expect(records(all, "status")).toEqual([])
})

test("a session that ends mid-stream is released after its late model and turn ends", async () => {
  const { start, emit, read, bus, recorder } = setup()
  start(10)
  emit("turn.start", 20, { prompt: { role: "user", content: [] } })
  emit("message.start", 25, { model })
  emit("session.end", 30, { reason: "switch" })
  await bus.flush()
  await recorder.flush()
  emit("message.end", 40, { message: { role: "assistant", content: [], model, stopReason: "aborted" } })
  emit("turn.end", 50, { reason: "aborted", steps: 1 })
  await read()
  await Bun.sleep(5)
  emit("status.changed", 60, { status: "idle" })
  const all = await read()
  expect(records(all, "model")).toHaveLength(1)
  expect(records(all, "turn")).toHaveLength(1)
  expect(records(all, "status")).toEqual([])
})
