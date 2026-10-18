import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { Agent, type AgentPort, type FrontendSnapshot, type FrontendUpdate } from "@amira/core"
import { createSessionDisplay, showAgentSession } from "../src/app/session-display.ts"
import { messageTimestamp } from "../src/format.ts"
import { setup, waitFor } from "./app-harness.ts"

const snapshot: FrontendSnapshot = {
  sessionGeneration: 2,
  state: {
    sessionId: "session",
    cwd: "/workspace",
    resumed: true,
    updatedAt: 2000,
    status: "idle",
    model: { provider: "mock", id: "m", contextWindow: 1000 },
    children: 0,
  },
  transcript: {
    messages: [
      {
        id: "entry:user",
        entryId: "entry",
        ts: 1000,
        message: { role: "user", content: [{ type: "text", text: "summary" }] },
        compaction: { reason: "manual", tokensBefore: 100, tokensAfter: 10 },
      },
    ],
    displays: [
      {
        id: "display",
        before: 0,
        level: "info",
        text: "saved",
        options: { details: "detail", markdown: true },
      },
    ],
  },
}

test("session display consumes a JSON-roundtripped snapshot, including anchors and compaction metadata", () => {
  const copy: FrontendSnapshot = JSON.parse(JSON.stringify(snapshot))
  let opened = false
  showAgentSession(
    {
      openSession(boundary, messages, switched, compactionInfo, displays) {
        opened = true
        expect(boundary).toEqual({ id: "session", resumed: true, updatedAt: 2000 })
        expect(switched).toBe(true)
        expect(messages[0]).toEqual(copy.transcript.messages[0]!.message)
        expect(compactionInfo?.(messages[0]!)).toEqual(copy.transcript.messages[0]!.compaction)
        expect(messageTimestamp(messages[0]!)).toBe(1000)
        expect(displays).toEqual(copy.transcript.displays)
      },
    },
    copy,
    true,
  )
  expect(opened).toBe(true)
})

test("projection failure is visible without replaying transcript effects; unsubscribe releases the listener", () => {
  let listener: ((update: FrontendUpdate) => void) | undefined
  const port: AgentPort = {
    snapshot,
    subscribe(next) {
      listener = next
      return () => {
        listener = undefined
      }
    },
    async execute() {
      throw new Error("This display-only fixture does not execute operations")
    },
    async detach() {},
  }
  const notices: string[] = []
  let renders = 0
  const display = createSessionDisplay(port, {
    openSession: () => {
      throw new Error("unexpected transcript replay")
    },
    notice: (_level, text) => {
      notices.push(text)
    },
    requestRender: () => {
      renders++
    },
  })
  listener?.(
    JSON.parse(
      JSON.stringify({
        kind: "error",
        error: { code: "invalid_snapshot", message: "invalid frontend data" },
      }),
    ),
  )
  listener?.(JSON.parse(JSON.stringify({ kind: "snapshot", snapshot })))
  expect(notices).toEqual(["invalid frontend data"])
  expect(renders).toBe(2)
  display.dispose()
  expect(listener).toBeUndefined()
})

test("a failed switch displays the new session once its projection recovers", async () => {
  const s = await setup([{ text: "old answer" }], {
    commands: [],
    prepare: (agent) => agent.prompt("old question"),
  })
  const next = new Agent({ ai: s.ai, model: s.agent.model, cwd: s.agent.cwd, systemPrompt: "", bus: s.bus })
  next.messages.push({
    role: "toolResult",
    toolCallId: "bad",
    toolName: "bad",
    content: [],
    isError: true,
    details: Number.POSITIVE_INFINITY,
  })
  try {
    s.commands!.switchTo(next)
    await s.bus.flush()
    next.messages.splice(0, 1, userMessage("recovered session question"))
    s.bus.emit("ui.render", {}, { sessionId: "host" })
    await s.bus.flush()
    await waitFor(() => s.live().includes("recovered session question"), "recovered session displayed")
    expect(s.live()).not.toContain("old question")
  } finally {
    s.terminal.send("\x03\x03\x03")
    await s.exited
    await next.dispose()
    await s.agent.dispose()
  }
})
