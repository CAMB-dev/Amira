// Manual benchmark (not part of `bun run check`): `bun scripts/trace-benchmark.ts` compares a
// 200-tool-call mock run with and without the TraceRecorder and prints the overhead.
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "../packages/ai/src/index.ts"
import { defineTool, textResult } from "../packages/api/src/index.ts"
import { Agent, EventBus, SessionStore, TraceRecorder } from "../packages/core/src/index.ts"

// No catalog, extension, title, or network work. Both arms persist the same 200-call run.
const directory = mkdtempSync(path.join(tmpdir(), "amira-trace-benchmark-"))
const previousHome = process.env.AMIRA_HOME
process.env.AMIRA_HOME = path.join(directory, "home")
const calls = 200
const warmups = 4
const samples = 11
let run = 0

async function measure(recording: boolean) {
  const dir = path.join(directory, `run-${++run}`)
  const store = SessionStore.create({ cwd: directory, dir })
  const mock = createMockDialect([
    {
      toolCalls: Array.from({ length: calls }, (_, n) => ({
        name: "fake",
        id: `call-${n}`,
        args: { n, text: "x".repeat(64) },
      })),
    },
    { text: "done" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  let observed = 0
  bus.subscribe((event) => {
    if (event.type === "tool.execute.end") observed++
  })
  const recorder = recording ? new TraceRecorder(bus) : undefined
  recorder?.register(store.id, store.file)
  const agent = new Agent({
    ai,
    bus,
    session: store,
    cwd: directory,
    model: ai.model("mock/test"),
    systemPrompt: "benchmark",
    compaction: { auto: false },
  })
  agent.tools.register(
    defineTool({
      name: "fake",
      description: "deterministic fake tool",
      concurrency: "parallel",
      traits: { readOnly: true },
      parameters: { type: "object" },
      execute: async () => textResult("y".repeat(64)),
    }),
    "benchmark",
  )
  agent.start("startup")
  const begin = performance.now()
  const result = await agent.prompt("execute the deterministic batch")
  const turnMs = performance.now() - begin
  await agent.dispose("exit")
  await bus.flush()
  await recorder?.close()
  const totalMs = performance.now() - begin
  if (result.reason !== "done" || observed !== calls)
    throw new Error(`Incomplete fake run: ${observed} tools`)
  let traceBytes = 0
  let traceRecords = 0
  if (recorder) {
    const records = await recorder.read(store.file)
    if (records.filter((record) => record.type === "tool").length !== calls)
      throw new Error("Trace lost tool records")
    traceRecords = records.length
    traceBytes = statSync(`${store.file}.trace.jsonl`).size
  }
  return { turnMs, totalMs, traceBytes, traceRecords }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
try {
  for (let n = 0; n < warmups; n++) {
    await measure(false)
    await measure(true)
  }
  const baseline: Awaited<ReturnType<typeof measure>>[] = []
  const recorded: Awaited<ReturnType<typeof measure>>[] = []
  for (let n = 0; n < samples; n++) {
    for (const enabled of n % 2 ? [true, false] : [false, true]) {
      const result = await measure(enabled)
      ;(enabled ? recorded : baseline).push(result)
    }
  }
  const metric = (key: "turnMs" | "totalMs") => {
    const without = median(baseline.map((sample) => sample[key]))
    const withRecorder = median(recorded.map((sample) => sample[key]))
    return {
      baselineMs: without,
      recordedMs: withRecorder,
      overheadMs: withRecorder - without,
      overheadPercent: (withRecorder / without - 1) * 100,
    }
  }
  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        platform: process.platform,
        calls,
        warmupPairs: warmups,
        samplePairs: samples,
        turn: metric("turnMs"),
        includingFinalFlush: metric("totalMs"),
        traceRecords: recorded[0]!.traceRecords,
        traceBytesMedian: median(recorded.map((sample) => sample.traceBytes)),
        baseline,
        recorded,
      },
      null,
      2,
    ),
  )
} finally {
  if (previousHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
}
