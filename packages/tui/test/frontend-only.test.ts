import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyEvent, EventMap } from "@amira/api"
import type {
  AgentPort,
  FrontendMessage,
  FrontendOperations,
  FrontendSnapshot,
  FrontendUpdate,
} from "@amira/core"
import { EventBus, UiRequests } from "@amira/core"
import { FakeTerminal } from "@amira/tui-kit"
import { StatusRegistry } from "../../core/src/status-registry.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import type { FrontendConversationUpdate } from "../src/app/frontend-focus.ts"
import type { FrontendEffect } from "../src/app/startup.ts"
import { type InteractiveOptions, runInteractive } from "../src/app.ts"
import { noProbe, waitFor } from "./app-harness.ts"

function snapshot(messages: FrontendMessage[] = []): FrontendSnapshot {
  return {
    sessionGeneration: 1,
    state: {
      sessionId: "remote-main",
      cwd: "/remote/must-not-be-walked",
      resumed: !!messages.length,
      status: "idle",
      model: { provider: "mock", id: "remote-model", contextWindow: 1000, caps: { images: false } },
      permissionMode: "plan",
      children: 0,
    },
    transcript: { messages: messages.map((message, i) => ({ id: `message-${i}`, message })), displays: [] },
  }
}

async function fixture(options: Partial<InteractiveOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), "amira-frontend-tui-"))
  let current = snapshot()
  let connection: NonNullable<AgentPort["connection"]> = "connected"
  const updates = new Set<(update: FrontendUpdate) => void>()
  const events = new Set<(event: AnyEvent, context?: { replay: boolean }) => void>()
  const connections = new Set<() => void>()
  const effects = new Set<(effect: FrontendEffect) => void>()
  const calls: { operation: keyof FrontendOperations; params: unknown; generation?: number }[] = []
  let detached = 0
  const frontend: AgentPort = {
    quitBehavior: "detach",
    get snapshot() {
      return current
    },
    get connection() {
      return connection
    },
    subscribe(listener) {
      updates.add(listener)
      return () => {
        updates.delete(listener)
      }
    },
    subscribeEvents(listener) {
      events.add(listener)
      return () => {
        events.delete(listener)
      }
    },
    subscribeConnection(listener) {
      connections.add(listener)
      return () => {
        connections.delete(listener)
      }
    },
    async execute(operation, params, opts) {
      calls.push({ operation, params, generation: opts?.sessionGeneration })
      throw new Error("fixture operation not admitted")
    },
    async detach() {
      detached++
    },
  }
  const terminal = new FakeTerminal(100, 30)
  const screen = new VirtualScreen(100, 30)
  const write = terminal.write.bind(terminal)
  terminal.write = (text) => {
    write(text)
    screen.write(text)
  }
  const exited = runInteractive({
    frontend,
    terminal,
    status: new StatusRegistry(),
    setup: noProbe,
    localCwd: home,
    settings: { margin: 0, marginRows: 0 },
    env: { HOME: home, USERPROFILE: home, AMIRA_HOME: home, TERM_PROGRAM: "WezTerm" },
    subscribeFrontendEffects(listener) {
      effects.add(listener)
      return () => {
        effects.delete(listener)
      }
    },
    ...options,
  })
  const live = () => screen.lines.join("\n")
  await waitFor(() => live().includes("Message Amira"), "frontend-only composer")
  let seq = 0
  return {
    frontend,
    terminal,
    screen,
    calls,
    exited,
    live,
    emit<K extends keyof EventMap>(type: K, data: EventMap[K], replay = false) {
      const event = {
        type,
        data,
        sessionId: current.state.sessionId,
        seq: ++seq,
        ts: Date.now(),
        turnId: current.state.turnId,
      } as AnyEvent
      for (const listener of events) listener(event, { replay })
    },
    update(next: FrontendSnapshot, reset = false) {
      current = next
      for (const listener of updates) listener({ kind: "snapshot", snapshot: current, reset })
    },
    effect(effect: FrontendEffect) {
      for (const listener of effects) listener(effect)
    },
    connection(status: typeof connection) {
      connection = status
      for (const listener of connections) listener()
    },
    async close() {
      try {
        for (const listener of effects) listener({ kind: "detach" })
        expect(await exited).toBe(0)
        expect(detached).toBe(1)
        expect(updates.size + events.size + connections.size + effects.size).toBe(0)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
  }
}

test("frontend-only TUI displays connection, rejects operations without losing the draft, and detaches", async () => {
  const s = await fixture()
  try {
    expect(s.live()).toContain("remote-model")
    expect(s.live()).toContain("plan")
    expect(s.live()).toContain("Remote connected")
    s.connection("reconnecting")
    await waitFor(() => s.live().includes("Remote reconnecting"), "connection state")
    s.terminal.send("remote draft\r")
    await waitFor(() => s.calls.length === 1, "remote prompt")
    expect(s.calls[0]).toMatchObject({ operation: "turn.prompt", generation: 1 })
    await waitFor(() => s.live().includes("fixture operation not admitted"), "rejected prompt")
    expect(s.live()).toContain("remote draft")
  } finally {
    await s.close()
  }
})

test("frontend-only TUI never displays or accepts host-local input suggestions", async () => {
  const ui = new UiRequests(new EventBus())
  const accepted: string[] = []
  ui.api("test").onInputSuggestionAccepted((text) => accepted.push(text))
  ui.api("test").setInputSuggestion("Local only ghost")
  const s = await fixture({ ui })
  try {
    expect(s.live()).not.toContain("Local only ghost")
    s.terminal.send("\t")
    await Bun.sleep(30)
    expect(s.live()).not.toContain("Local only ghost")
    expect(accepted).toEqual([])
    expect(s.calls).toEqual([])
  } finally {
    await s.close()
  }
})

test("connection failure cause and recovery appear in the active focused transcript", async () => {
  const s = await fixture({
    conversations: {
      async open(ref) {
        return {
          snapshot: { ...ref, name: "Focused remote", cwd: "/remote/owned", messages: [], busy: false },
          dispose() {},
        }
      },
    },
  })
  try {
    s.effect({ kind: "focus", conversationId: "owned", incarnation: "owned-1" })
    await waitFor(() => s.live().includes("Message Focused remote"), "focused composer")
    Object.defineProperty(s.frontend, "connectionIssue", {
      value: {
        code: "consent_required",
        message: "Remote target changed",
        recovery: "Run amira remote add again",
        retryable: false,
      },
    })
    s.connection("disconnected")
    await waitFor(() => s.live().includes("Remote target changed"), "visible connection failure")
    expect(s.live()).toContain("Run amira remote add again")
    expect(s.live()).toContain("Message Focused remote")
  } finally {
    await s.close()
  }
})

test("late streaming attachment reconciles final content; resets replace rather than duplicate history", async () => {
  const s = await fixture()
  try {
    s.emit("message.delta", { kind: "text", text: "tail" })
    const answer: FrontendMessage = {
      role: "assistant",
      content: [{ type: "text", text: "complete tail" }],
      model: { provider: "mock", model: "remote-model" },
    }
    s.emit("message.end", { message: answer })
    await waitFor(() => s.live().includes("complete tail"), "authoritative reply")
    const next = snapshot([answer])
    s.update(next, true)
    await waitFor(() => s.live().includes("complete tail"), "reset history")
    expect(s.live().split("complete tail")).toHaveLength(2)
    s.update({
      ...snapshot(),
      sessionGeneration: 2,
      state: { ...snapshot().state, sessionId: "replacement" },
    })
    await waitFor(() => !s.live().includes("complete tail"), "replacement history")
  } finally {
    await s.close()
  }
})

test("remote markdown keeps web links clickable but never emits file links", async () => {
  const s = await fixture()
  try {
    const answer: FrontendMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "[web](https://example.com) [file](file:///remote/secret) [drive](C:/private) [relative](src/secret.ts)",
        },
      ],
      model: { provider: "mock", model: "remote-model" },
    }
    s.update(snapshot([answer]), true)
    await waitFor(() => s.live().includes("relative"), "remote links")
    expect(s.terminal.output).toContain("\x1b]8;;https://example.com")
    expect(s.terminal.output).not.toContain("\x1b]8;;file:")
    expect(s.terminal.output).not.toContain("\x1b]8;;C:")
    expect(s.terminal.output).not.toContain("\x1b]8;;src/")
  } finally {
    await s.close()
  }
})

test("remote focus uses DTO history/control and restores the main draft with F6", async () => {
  let disposed = 0
  const s = await fixture({
    conversations: {
      async open(ref) {
        return {
          snapshot: {
            ...ref,
            name: "Owned remote",
            cwd: "/remote/owned",
            busy: false,
            messages: [{ role: "user", content: [{ type: "text", text: "owned history" }] }],
          },
          dispose() {
            disposed++
          },
        }
      },
    },
  })
  try {
    s.terminal.send("main draft")
    s.effect({ kind: "focus", conversationId: "owned", incarnation: "owned-1" })
    await waitFor(() => s.live().includes("owned history"), "DTO focus")
    expect(s.live()).toContain("Message Owned remote")
    s.terminal.send("owned question\r")
    await waitFor(() => s.calls.some((call) => call.operation === "conversation.send"), "DTO send")
    expect(s.calls.find((call) => call.operation === "conversation.send")?.params).toMatchObject({
      conversationId: "owned",
      incarnation: "owned-1",
    })
    s.terminal.send("\x1b[17~")
    await waitFor(
      () => s.live().includes("main draft") && !s.live().includes("owned history"),
      "return to main",
    )
    expect(s.live()).toContain("main draft")
    expect(disposed).toBe(1)
  } finally {
    await s.close()
  }
})

test("frontend-only interrupt names the cached remote turn instead of needing a local Agent", async () => {
  const s = await fixture()
  try {
    const next = snapshot()
    s.update({ ...next, state: { ...next.state, status: "working", turnId: "remote-turn-7" } }, true)
    s.terminal.send("\x1b")
    await waitFor(() => s.calls.some((call) => call.operation === "turn.abort"), "remote abort")
    expect(s.calls.find((call) => call.operation === "turn.abort")).toMatchObject({
      params: { turnId: "remote-turn-7" },
      generation: 1,
    })
  } finally {
    await s.close()
  }
})

test("cancelled DTO focus disposes a late snapshot without stealing the composer", async () => {
  const opened = Promise.withResolvers<{
    snapshot: import("../src/app/frontend-focus.ts").FrontendConversationSnapshot
    dispose(): void
  }>()
  let disposed = 0
  const s = await fixture({ conversations: { open: () => opened.promise } })
  try {
    s.terminal.send("kept draft")
    await waitFor(() => s.live().includes("kept draft"), "main draft frame")
    s.effect({ kind: "focus", conversationId: "late", incarnation: "late-1" })
    s.effect({ kind: "unfocus" })
    opened.resolve({
      snapshot: {
        conversationId: "late",
        incarnation: "late-1",
        name: "Late view",
        cwd: "/remote/late",
        messages: [],
        busy: false,
      },
      dispose() {
        disposed++
      },
    })
    await waitFor(() => disposed === 1, "stale focus disposal")
    expect(s.live()).toContain("kept draft")
    expect(s.live()).not.toContain("Late view")
  } finally {
    await s.close()
  }
})

test("main requests wait behind DTO focus and become visible on return", async () => {
  const s = await fixture({
    requests: {
      requestState: () => "pending",
      respond: async () => ({ status: "accepted" }),
      form() {
        throw new Error("not a form")
      },
      settings() {
        throw new Error("not settings")
      },
    },
    conversations: {
      async open(ref) {
        return {
          snapshot: { ...ref, name: "Owned remote", cwd: "/remote/owned", busy: false, messages: [] },
          dispose() {},
        }
      },
    },
  })
  try {
    s.effect({ kind: "focus", conversationId: "owned", incarnation: "owned-1" })
    await waitFor(() => s.live().includes("Message Owned remote"), "DTO focus")
    s.emit("ui.request", { kind: "confirm", title: "Root question", requestId: "root-request" })
    await waitFor(() => s.live().includes("Main needs an answer"), "main attention")
    expect(s.live()).not.toContain("Root question")
    s.terminal.send("\x1b[17~")
    await waitFor(() => s.live().includes("Root question"), "main request restored")
  } finally {
    await s.close()
  }
})

test("replayed turn completion never sends locally queued input, and live steering renders once", async () => {
  const s = await fixture({ settings: { submitWhileWorking: "queue" } })
  try {
    s.emit("turn.start", { prompt: { role: "user", content: [{ type: "text", text: "original" }] } })
    s.terminal.send("queued input\r")
    await waitFor(() => s.live().includes("queued input"), "queued local input")
    s.emit("turn.end", { reason: "done", steps: 1 }, true)
    await Bun.sleep(30)
    expect(s.calls).toHaveLength(0)
    const message = { role: "user" as const, content: [{ type: "text" as const, text: "injected steering" }] }
    s.emit("turn.steer", { message, state: "queued" })
    s.emit("turn.steer", { message, state: "injected" })
    await waitFor(() => s.live().includes("injected steering"), "live steering")
    expect(s.live().split("injected steering")).toHaveLength(2)
  } finally {
    await s.close()
  }
})

test("DTO focus does not render a descendant's private message as its own reply", async () => {
  let receive: ((update: FrontendConversationUpdate) => void) | undefined
  const s = await fixture({
    conversations: {
      async open(ref, listener) {
        receive = listener
        return {
          snapshot: { ...ref, name: "Owned remote", cwd: "/remote/owned", busy: false, messages: [] },
          dispose() {},
        }
      },
    },
  })
  try {
    s.effect({ kind: "focus", conversationId: "owned", incarnation: "owned-1" })
    await waitFor(() => s.live().includes("Message Owned remote"), "DTO focus")
    receive?.({
      kind: "event",
      event: {
        type: "message.delta",
        data: { kind: "text", text: "private child text" },
        sessionId: "child",
        parentSessionId: "owned",
        seq: 1,
        ts: Date.now(),
      },
    })
    receive?.({
      kind: "event",
      event: {
        type: "message.end",
        data: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "owned reply" }],
            model: { provider: "mock", model: "remote-model" },
          },
        },
        sessionId: "owned",
        seq: 2,
        ts: Date.now(),
      },
    })
    await waitFor(() => s.live().includes("owned reply"), "owned reply")
    expect(s.live()).not.toContain("private child text")
  } finally {
    await s.close()
  }
})
