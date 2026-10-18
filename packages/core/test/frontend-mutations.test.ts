import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { createLocalAgentPort } from "../src/frontend/local-port.ts"
import { isFrontendError } from "../src/frontend/operations.ts"

function fixture(steps: MockStep[] = []) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  const port = createLocalAgentPort({ agent })
  return { agent, port, mock }
}

function json<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value))
  expect(copy).toEqual(value)
  return copy
}

test("prompt acknowledges admission before completion; busy error facts survive JSON", async () => {
  const gate = Promise.withResolvers<void>()
  const s = fixture([{ text: "reply after gate", hold: { chunks: 0, until: gate.promise } }])
  try {
    expect(json(await s.port.execute("turn.prompt", json({ message: "question" })))).toEqual({
      sessionGeneration: 1,
    })
    expect(s.agent.busy).toBe(true)
    try {
      await s.port.execute("turn.prompt", { message: "duplicate" })
      throw new Error("expected rejection")
    } catch (error) {
      expect(isFrontendError(error, "agent_busy")).toBe(true)
      expect(isFrontendError(json({ code: "agent_busy", message: "busy" }), "agent_busy")).toBe(true)
    }
    await s.port.execute("turn.abort", {})
  } finally {
    gate.resolve()
    await s.port.detach()
    await s.agent.dispose()
  }
})

test("steering preserves ordered rich content, image names and display metadata", async () => {
  const gate = Promise.withResolvers<void>()
  const s = fixture([
    { text: "waiting for steering", hold: { chunks: 0, until: gate.promise } },
    { text: "done" },
  ])
  const events: unknown[] = []
  const off = s.agent.bus.subscribe((event) => {
    if (event.type === "turn.steer") events.push(json(event.data))
  })
  const message = userMessage("before")
  message.content.push(
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png", name: "local.png" },
    { type: "text", text: "after" },
  )
  message.display = { text: "folded", note: "attachment" }
  try {
    await s.port.execute("turn.prompt", { message: "question" })
    expect(await s.port.execute("turn.steer", json({ message }))).toEqual({ sessionGeneration: 1 })
    await s.agent.bus.flush()
    expect(events).toContainEqual({ message, state: "queued" })
    await s.port.execute("turn.abort", {})
  } finally {
    gate.resolve()
    off()
    await s.port.detach()
    await s.agent.dispose()
  }
})

test("cancelled and stale mutations do not retarget the replacement agent", async () => {
  const first = fixture()
  const second = fixture()
  let switched: ((agent: Agent) => void) | undefined
  const port = createLocalAgentPort({
    agent: first.agent,
    commands: {
      onSwitch: (listener) => {
        switched = listener
        return () => {}
      },
    },
  })
  const generation = port.snapshot.sessionGeneration
  const cancelled = AbortSignal.abort(new Error("cancelled"))
  try {
    await expect(
      port.execute("turn.prompt", { message: "cancelled" }, { signal: cancelled }),
    ).rejects.toMatchObject({ code: "cancelled" })
    switched!(second.agent)
    expect(port.snapshot.sessionGeneration).toBe(generation + 1)
    await expect(
      port.execute("turn.prompt", { message: "old" }, { sessionGeneration: generation }),
    ).rejects.toMatchObject({ code: "stale_session" })
    expect(first.agent.messages).toEqual([])
    expect(second.agent.messages).toEqual([])
    expect(
      json(await port.execute("turn.prompt", { message: "new" }, { sessionGeneration: generation + 1 })),
    ).toEqual({ sessionGeneration: generation + 1 })
  } finally {
    await port.detach()
    await first.port.detach()
    await second.port.detach()
    await first.agent.dispose()
    await second.agent.dispose()
  }
})

test("detach rejects operations without aborting an admitted turn", async () => {
  const gate = Promise.withResolvers<void>()
  const s = fixture([{ text: "reply after reconnect", hold: { chunks: 0, until: gate.promise } }])
  const ended = Promise.withResolvers<void>()
  const off = s.agent.bus.subscribe((event) => {
    if (event.type === "turn.end") ended.resolve()
  })
  try {
    expect(s.port.quitBehavior).toBe("stop")
    await s.port.execute("turn.prompt", { message: "question" })
    await s.port.detach()
    expect(s.agent.busy).toBe(true)
    await expect(s.port.execute("turn.abort", {})).rejects.toMatchObject({ code: "disconnected" })
    gate.resolve()
    await ended.promise
    expect(s.agent.status).toBe("idle")
    expect(s.agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "reply after reconnect" }],
    })
  } finally {
    gate.resolve()
    off()
    await s.port.detach()
    await s.agent.dispose()
  }
})

test("unsupported operations fail explicitly and invalid payloads never start a turn", async () => {
  const s = fixture()
  try {
    await expect(s.port.execute("session.resume", { id: "missing" })).rejects.toMatchObject({
      code: "unsupported_operation",
    })
    await expect(
      s.port.execute("turn.prompt", {
        message: { ...userMessage("bad"), display: { text: Number.POSITIVE_INFINITY as unknown as string } },
      }),
    ).rejects.toThrow("finite JSON")
    expect(s.agent.messages).toEqual([])
  } finally {
    await s.port.detach()
    await s.agent.dispose()
  }
})

test("a failed display projection cannot disable abort or command-based session recovery", async () => {
  const first = fixture()
  const second = fixture()
  let switched: ((agent: Agent) => void) | undefined
  let aborts = 0
  const originalAbort = first.agent.abort.bind(first.agent)
  first.agent.abort = () => {
    aborts++
    originalAbort()
  }
  const port = createLocalAgentPort({
    agent: first.agent,
    commands: {
      onSwitch: (listener) => {
        switched = listener
        return () => {}
      },
      run: async () => {
        switched!(second.agent)
        return { ok: true, output: [] }
      },
    },
  })
  try {
    first.agent.messages.push({
      role: "toolResult",
      toolCallId: "bad",
      toolName: "bad",
      content: [],
      isError: true,
      details: Number.POSITIVE_INFINITY,
    })
    first.agent.bus.emit("ui.render", {}, { sessionId: "host" })
    await first.agent.bus.flush()
    await expect(port.execute("state.read", {})).rejects.toThrow("Frontend data")
    await port.execute("turn.abort", {})
    expect(aborts).toBe(1)
    expect(await port.execute("command.run", { line: "/clear" })).toEqual({ ok: true, output: [] })
    expect(await port.execute("state.read", {})).toMatchObject({ sessionId: second.agent.sessionId })
    expect(port.snapshot.sessionGeneration).toBe(2)
  } finally {
    await port.detach()
    await first.port.detach()
    await second.port.detach()
    await first.agent.dispose()
    await second.agent.dispose()
  }
})
