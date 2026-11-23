import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { emptyUsage, summarizeTrace, type TraceRecord } from "@amira/api"
import { readTrace } from "../src/trace-reader.ts"

const header: TraceRecord = { type: "trace", v: 1, sessionId: "root", startedAt: 10 }
const status: TraceRecord = { type: "status", at: 20, status: "working" }
const model: TraceRecord = { type: "model", model: "mock/test", start: 10, end: 20 }
const resumed: TraceRecord = { ...header, startedAt: 30 }
const turn: TraceRecord = { type: "turn", turnId: "t", start: 30, end: 40, reason: "done", steps: 1 }

test("trace reader skips missing files, malformed records and unsupported versions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-reader-"))
  const file = path.join(dir, "root.jsonl")
  try {
    expect(await readTrace(file)).toEqual([])
    const records = [
      status,
      header,
      status,
      null,
      { type: "unknown" },
      { type: "status", at: "bad", status: "idle" },
      { ...model, retries: {} },
      { ...model, retries: [null] },
      { ...model, retries: [{ at: "bad", delayMs: 2, kind: "rate" }] },
      { ...model, firstToken: "bad" },
      { ...model, firstToken: null },
      { ...model, usage: {} },
      { ...model, usage: { ...emptyUsage(), input: "bad" } },
      { ...model, usage: { ...emptyUsage(), cost: { total: 1 } } },
      { ...model, usage: { ...emptyUsage(), reasoning: "bad" } },
      { ...turn, failure: { kind: "other", message: 5 } },
      { type: "compact", start: 10, end: 20, reason: "manual", native: "bad" },
      { ...header, role: {} },
      { ...header, v: 2 },
      status,
      resumed,
      turn,
    ]
    writeFileSync(
      `${file}.trace.jsonl`,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n{"type":`,
    )
    const read = await readTrace(file)
    expect(read).toEqual([header, status, resumed, turn])
    expect(() => summarizeTrace(read)).not.toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
