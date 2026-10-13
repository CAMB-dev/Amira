import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolCallBlock, ToolResult } from "@amira/api"
import { normalizeResult, resultMessage } from "../src/agent/messages.ts"
import { SessionStore } from "../src/session-store.ts"

const call: ToolCallBlock = { type: "toolCall", id: "c1", name: "question", args: {} }
const details = {
  questions: [{ question: "Which?", options: [{ label: "a, b" }, { label: "b" }] }],
  outcome: { answers: [{ selected: ["a, b"], other: "a note" }] },
}

test("presenter details are persisted only when the tool opts in", () => {
  const result: ToolResult = { content: [{ type: "text", text: "answered" }], details }
  const transient = normalizeResult(result)
  expect(transient.details).toEqual(details)
  expect(resultMessage(call, transient)).not.toHaveProperty("details")
  const durable = normalizeResult({ ...result, persistDetails: true })
  const message = JSON.parse(JSON.stringify(resultMessage(call, durable)))
  expect(message.details).toEqual(details)
  expect(message).not.toHaveProperty("persistDetails")
})

test("durable details also survive error results without changing rejection metadata", () => {
  const result = normalizeResult({
    content: [{ type: "text", text: "aborted" }],
    isError: true,
    details,
    persistDetails: true,
  })
  const message = resultMessage(call, result, "aborted")
  expect(message.details).toEqual(details)
  expect(message.isError).toBe(true)
  expect(message.rejected).toBe("aborted")
  expect(resultMessage(call, { content: [], persistDetails: true })).not.toHaveProperty("details")
})

test("oversized presenter details stay live but cannot bloat saved or resumed history", async () => {
  const large = { ...details, outcome: { answers: [{ selected: [], other: "x".repeat(2 * 1024 * 1024) }] } }
  const result = normalizeResult({
    content: [{ type: "text", text: "Saved output preview (artifact quota exceeded)." }],
    details: large,
    persistDetails: true,
  })
  const message = resultMessage(call, result)
  expect(message).not.toHaveProperty("details")
  expect(message.content).toEqual(result.content)
  expect(result.details).toBe(large)
  const dir = await mkdtemp(path.join(tmpdir(), "amira-presenter-history-"))
  try {
    const store = SessionStore.create({ cwd: dir, dir })
    const old = resultMessage(call, { content: [{ type: "text", text: "Old saved answer" }] })
    store.appendMessage(old)
    store.appendMessage(message)
    expect(Buffer.byteLength(await readFile(store.file, "utf8"))).toBeLessThan(4096)
    expect(SessionStore.open(store.file).restore().messages).toEqual([old, message])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("durable details use a 16 KiB serialized UTF-8 cap, including JSON quotes and escapes", () => {
  const message = (details: unknown) => resultMessage(call, { content: [], details, persistDetails: true })
  const atLimit = "x".repeat(16 * 1024 - 2)
  expect(message(atLimit).details).toBe(atLimit)
  expect(message(`${atLimit}x`)).not.toHaveProperty("details")
  // Both fit in 16K JavaScript characters, but not in serialized UTF-8 bytes.
  expect(message("界".repeat(6000))).not.toHaveProperty("details")
  expect(message("\n".repeat(8192))).not.toHaveProperty("details")
})

test("durable details are a JSON snapshot; unsafe values cannot prevent saving the result", () => {
  const original = { selected: ["Patch"] }
  const message = resultMessage(call, { content: [], details: original, persistDetails: true })
  original.selected.push("Docs")
  expect(message.details).toEqual({ selected: ["Patch"] })
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  for (const details of [cycle, { count: 1n }, () => "not JSON"]) {
    const m = resultMessage(call, { content: [], details, persistDetails: true })
    expect(m).not.toHaveProperty("details")
    expect(() => JSON.stringify(m)).not.toThrow()
  }
})
