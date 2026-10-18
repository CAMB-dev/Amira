import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type Message, type MockStep, userMessage } from "@amira/ai"
import { textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { summaryMessages } from "../src/compaction.ts"
import { createLocalAgentPort } from "../src/frontend/local-port.ts"
import type { FrontendUpdate } from "../src/frontend/port.ts"
import type { FrontendSnapshot } from "../src/frontend/snapshot.ts"
import { SessionStore } from "../src/session-store.ts"

function roundtrip<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value))
  expect(copy).toEqual(value)
  return copy
}

function setup(session?: SessionStore, steps: MockStep[] = [{ text: "reply", thinking: "reasoning" }]) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "", session })
  return { agent, ai }
}

test("read operations and subscriptions return detached, immutable JSON DTOs with stable identities", async () => {
  const { agent } = setup()
  const port = createLocalAgentPort({ agent })
  const updates: FrontendUpdate[] = []
  const off = port.subscribe((update) => updates.push(roundtrip(update)))
  const initial = roundtrip(port.snapshot)
  try {
    expect(initial.state).toMatchObject({ cwd: "/workspace", resumed: false, status: "idle", children: 0 })
    expect(await port.execute("state.read", roundtrip({}))).toEqual(initial.state)
    await agent.prompt("question")
    await agent.bus.flush()
    const snapshot = roundtrip(port.snapshot)
    expect(snapshot.state).toMatchObject({ resumed: true, status: "idle", sessionId: agent.sessionId })
    expect<Message[]>(snapshot.transcript.messages.map((entry) => entry.message)).toEqual(agent.messages)
    expect(initial.transcript.messages).toHaveLength(0)
    expect(Object.isFrozen(port.snapshot.transcript.messages[0]?.message.content)).toBe(true)
    expect(port.snapshot.transcript.messages[0]?.message).not.toBe(agent.messages[0])
    const ids = snapshot.transcript.messages.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(2)
    expect(roundtrip(await port.execute("transcript.read", roundtrip({})))).toEqual(snapshot.transcript)
    agent.bus.emit("ui.render", {}, { sessionId: "host" })
    await agent.bus.flush()
    expect(port.snapshot.transcript.messages.map((entry) => entry.id)).toEqual(ids)
    expect(updates.length).toBeGreaterThan(0)
    off()
    const count = updates.length
    await port.detach()
    await port.detach()
    agent.bus.emit("ui.render", {}, { sessionId: "host" })
    await agent.bus.flush()
    expect(updates).toHaveLength(count)
    // Detaching the projection does not dispose/abort the local agent.
    expect(agent.status).toBe("idle")
    expect(agent.messages).toHaveLength(2)
  } finally {
    off()
    await port.detach()
    await agent.dispose()
  }
})

test("presentation and descendant streaming reuse the settled transcript and cached state", async () => {
  const { agent } = setup()
  await agent.prompt("cached question")
  const port = createLocalAgentPort({ agent })
  const snapshot = port.snapshot
  const updates: FrontendUpdate[] = []
  const off = port.subscribe((update) => updates.push(roundtrip(update)))
  try {
    for (let i = 0; i < 100; i++) {
      agent.bus.emit("ui.render", {}, { sessionId: "host" })
      agent.bus.emit("message.delta", { kind: "text", text: "child" }, { sessionId: "child" })
      agent.bus.emit("status.changed", { status: "working" }, { sessionId: "child" })
    }
    await agent.bus.flush()
    expect(port.snapshot).toBe(snapshot)
    expect(port.snapshot.transcript.messages[0]).toBe(snapshot.transcript.messages[0])
    expect(updates).toHaveLength(0)
  } finally {
    off()
    await port.detach()
    await agent.dispose()
  }
})

for (const path of ["b.ts", Number.POSITIVE_INFINITY]) {
  test(`supported in-place tool argument changes refresh cached messages: ${path}`, async () => {
    const { agent } = setup(undefined, [
      { toolCalls: [{ id: "call", name: "read", args: { path: "a.ts" } }] },
      { text: "done" },
    ])
    const port = createLocalAgentPort({ agent })
    const updates: FrontendUpdate[] = []
    const off = port.subscribe((update) => updates.push(roundtrip(update)))
    let projectedBeforeMutation = false
    agent.tools.register(
      {
        name: "read",
        description: "",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        execute: async () => textResult("read"),
      },
      "test",
    )
    agent.interceptors.add("tool.call.before", async (value) => {
      await agent.bus.flush()
      projectedBeforeMutation = port.snapshot.transcript.messages.some(
        (entry) => entry.message.role === "assistant",
      )
      value.args.path = path
      return { action: "pass" }
    })
    try {
      await agent.prompt("read file")
      await agent.bus.flush()
      expect(projectedBeforeMutation).toBe(true)
      if (typeof path === "string") {
        expect(JSON.stringify(roundtrip(await port.execute("transcript.read", {})))).toContain(
          '"path":"b.ts"',
        )
      } else {
        expect(updates.at(-1)).toMatchObject({ kind: "error", error: { code: "invalid_snapshot" } })
        await expect(port.execute("transcript.read", {})).rejects.toThrow("Frontend data")
      }
    } finally {
      off()
      await port.detach()
      await agent.dispose()
    }
  })
}

test("runtime projection failures publish JSON errors and reject reads until recovery", async () => {
  const { agent } = setup()
  const port = createLocalAgentPort({ agent })
  const updates: FrontendUpdate[] = []
  const offBadListener = port.subscribe(() => {
    throw new Error("listener failed")
  })
  const off = port.subscribe((update) => updates.push(roundtrip(update)))
  try {
    agent.messages.push({
      role: "toolResult",
      toolCallId: "bad",
      toolName: "bad",
      content: [],
      isError: true,
      details: Number.POSITIVE_INFINITY,
    })
    agent.bus.emit("ui.render", {}, { sessionId: "host" })
    await agent.bus.flush()
    expect(updates.at(-1)).toMatchObject({ kind: "error", error: { code: "invalid_snapshot" } })
    await expect(port.execute("state.read", {})).rejects.toThrow("Frontend data")
    await expect(port.execute("transcript.read", {})).rejects.toThrow("Frontend data")
    agent.messages.pop()
    agent.messages.push(userMessage("recovered"))
    agent.bus.emit("ui.render", {}, { sessionId: "host" })
    await agent.bus.flush()
    expect(updates.at(-1)).toMatchObject({ kind: "snapshot" })
    expect(roundtrip(await port.execute("transcript.read", {})).messages).toHaveLength(1)
  } finally {
    offBadListener()
    off()
    await port.detach()
    await agent.dispose()
  }
})

test("fileless identities survive compaction and frontend recreation without reuse", async () => {
  const { agent } = setup()
  const port = createLocalAgentPort({ agent })
  let replacement: ReturnType<typeof createLocalAgentPort> | undefined
  try {
    await agent.prompt("old question")
    await agent.bus.flush()
    const previousIds = port.snapshot.transcript.messages.map((entry) => entry.id)
    agent.messages.splice(0, agent.messages.length, ...summaryMessages("summary"))
    agent.bus.emit("ui.render", {}, { sessionId: "host" })
    await agent.bus.flush()
    const ids = roundtrip(port.snapshot).transcript.messages.map((entry) => entry.id)
    expect(ids.every((id) => !previousIds.includes(id))).toBe(true)
    await port.detach()
    replacement = createLocalAgentPort({ agent })
    expect(roundtrip(replacement.snapshot).transcript.messages.map((entry) => entry.id)).toEqual(ids)
  } finally {
    await replacement?.detach()
    await port.detach()
    await agent.dispose()
  }
})

test("stored display anchors, timestamps, compactions and message IDs survive JSON and reopen", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-frontend-"))
  const store = SessionStore.create({ cwd: dir, dir })
  const first = store.appendMessage(userMessage("old question"))
  store.append({
    type: "display",
    level: "info",
    text: "saved output",
    details: "saved details",
    markdown: true,
  })
  store.append({
    type: "compaction",
    summary: "summary",
    replaces: [first],
    reason: "manual",
    model: { provider: "mock", model: "m" },
  })
  store.appendMessage(userMessage("next question"))
  store.rename("saved title")
  const { agent } = setup(SessionStore.open(store.file))
  const port = createLocalAgentPort({ agent })
  let reopened: Agent | undefined
  try {
    const snapshot = roundtrip(port.snapshot)
    expect(snapshot.state).toMatchObject({ title: "saved title", updatedAt: statSync(store.file).mtimeMs })
    expect(snapshot.transcript.displays).toEqual([
      expect.objectContaining({
        before: 1,
        text: "saved output",
        options: { details: "saved details", markdown: true },
      }),
    ])
    const entries = snapshot.transcript.messages
    expect(entries[0]?.compaction).toMatchObject({ reason: "manual" })
    expect(entries[0]?.entryId).toBe(entries[1]?.entryId)
    expect(entries[0]?.id).not.toBe(entries[1]?.id)
    expect(entries[2]?.ts).toBeNumber()
    reopened = setup(SessionStore.open(store.file)).agent
    const other = createLocalAgentPort({ agent: reopened })
    try {
      expect(roundtrip(other.snapshot).transcript).toEqual(snapshot.transcript)
    } finally {
      await other.detach()
    }
  } finally {
    await port.detach()
    await agent.dispose()
    await reopened?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("active-agent switches publish a generation-tagged snapshot and detach old subscriptions", async () => {
  const { agent } = setup()
  const { agent: next } = setup()
  let switchTo: ((next: Agent) => void) | undefined
  const commands = {
    onSwitch(listener: (next: Agent) => void) {
      switchTo = listener
      return () => {
        switchTo = undefined
      }
    },
  }
  const port = createLocalAgentPort({ agent, commands })
  const updates: FrontendSnapshot[] = []
  const off = port.subscribe((update) => {
    const copy = roundtrip(update)
    if (copy.kind === "snapshot") updates.push(copy.snapshot)
  })
  try {
    switchTo?.(next)
    expect(port.snapshot.sessionGeneration).toBe(2)
    expect(updates.at(-1)?.state.sessionId).toBe(next.sessionId)
    const count = updates.length
    agent.bus.emit("ui.render", {}, { sessionId: "host" })
    await agent.bus.flush()
    expect(updates).toHaveLength(count)
    await next.prompt("new session")
    await next.bus.flush()
    expect(roundtrip(port.snapshot).transcript.messages).toHaveLength(2)
    await port.detach()
    switchTo?.(agent)
    expect(port.snapshot.sessionGeneration).toBe(2)
  } finally {
    off()
    await port.detach()
    await agent.dispose()
    await next.dispose()
  }
})

test("rich message content remains JSON-safe and invalid opaque data fails closed", async () => {
  const { agent } = setup()
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "image", mimeType: "image/png", data: "aGVsbG8=", name: "picture.png" },
        { type: "text", text: "look" },
      ],
    },
    {
      role: "assistant",
      model: { provider: "mock", model: "m" },
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: 0.01 },
      content: [
        { type: "thinking", text: "", signature: { dialect: "mock", value: "signed" } },
        {
          type: "text",
          text: "",
          citations: [{ url: "https://example.invalid/source", title: "source", start: 0, end: 0 }],
        },
        {
          type: "serverTool",
          id: "hosted",
          name: "web_search",
          input: { query: "test" },
          status: "done",
          sources: [{ url: "https://example.invalid/source" }],
        },
        { type: "toolCall", id: "call", name: "read", args: { path: "a.ts", options: [true, null, 1] } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: true,
      rejected: "aborted",
      details: { nested: ["metadata"] },
    },
  ]
  agent.messages.push(...messages)
  const port = createLocalAgentPort({ agent })
  try {
    expect<Message[]>(roundtrip(port.snapshot).transcript.messages.map((entry) => entry.message)).toEqual(
      messages,
    )
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => {}, new Date(), cycle]) {
      agent.messages.push({
        role: "assistant",
        model: { provider: "mock", model: "m" },
        content: [{ type: "toolCall", id: "bad", name: "bad", args: { invalid } }],
      })
      expect(() => createLocalAgentPort({ agent })).toThrow("Frontend data")
      agent.messages.pop()
    }
  } finally {
    await port.detach()
    await agent.dispose()
  }
})
