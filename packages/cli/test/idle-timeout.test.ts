import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "@amira/core"
import { type PrintIO, runPrint } from "../src/print.ts"

const idleError = "model stream was idle for 20 ms. Type a message to continue, or press ↑ to resend."

/** A provider that shows one chunk, then stalls; a resend would consume the next reply. */
function stalledAgent() {
  let release!: () => void
  const until = new Promise<void>((resolve) => {
    release = resolve
  })
  const mock = createMockDialect([{ text: "partial answer", hold: { chunks: 1, until } }, { text: "resent" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 2, baseDelayMs: 1, firstContentTimeoutMs: 1000, idleTimeoutMs: 20 },
  })
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: import.meta.dir, systemPrompt: "" })
  return { agent, mock, release }
}

function capture(): PrintIO & { out: string; err: string } {
  const io = {
    out: "",
    err: "",
    stdout: (s: string) => {
      io.out += s
    },
    stderr: (s: string) => {
      io.err += s
    },
  }
  return io
}

test("plain print keeps partial stdout and reports an idle timeout with a recovery hint and exit 1", async () => {
  const { agent, mock, release } = stalledAgent()
  const io = capture()
  try {
    expect(await runPrint(agent, "go", false, { io })).toBe(1)
    expect(mock.requests).toHaveLength(1)
    expect(io.out).toBe("partial \n")
    expect(io.err).toBe(`error: ${idleError}\n`)
    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "partial " }],
      stopReason: "error",
    })
  } finally {
    release()
    await agent.dispose("exit")
  }
})

for (const destination of ["stdout", "file"] as const) {
  test(`JSON print to ${destination} retains idle timeout events and existing stderr behavior`, async () => {
    const { agent, mock, release } = stalledAgent()
    const io = capture()
    const dir = destination === "file" ? mkdtempSync(path.join(os.tmpdir(), "amira-idle-json-")) : undefined
    const jsonOut = dir ? path.join(dir, "events.jsonl") : undefined
    try {
      expect(await runPrint(agent, "go", true, { io, ...(jsonOut ? { jsonOut } : {}) })).toBe(1)
      expect(mock.requests).toHaveLength(1)
      expect(io.err).toBe(jsonOut ? `amira: run failed: ${idleError}\n` : "")
      if (jsonOut) expect(io.out).toBe("")
      const events: AnyEvent[] = (jsonOut ? readFileSync(jsonOut, "utf8") : io.out)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(events.filter((e) => e.type === "model.retry")).toEqual([])
      expect(events.find((e) => e.type === "message.delta")).toMatchObject({
        data: { kind: "text", text: "partial " },
      })
      expect(events.find((e) => e.type === "message.end")).toMatchObject({
        data: { message: { content: [{ type: "text", text: "partial " }], stopReason: "error" } },
      })
      expect(events.find((e) => e.type === "turn.end")).toMatchObject({
        data: { reason: "error", steps: 1, error: idleError, failure: { detail: idleError } },
      })
    } finally {
      release()
      await agent.dispose("exit")
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })
}
