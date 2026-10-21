import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, SessionControl, UiApi } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { CommandHost, CommandRegistry } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InputSuggestions } from "../src/input-suggestions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

for (const [input, expected] of [
  ["  next  question  ", "next question"],
  ["one\r\ntwo\nthree\rfour\tfive\u0085six\u2028seven\u2029eight", "one two three four five six seven eight"],
  ["\x1b[31mnext\x1b[0m \x1b]8;;https://example.test\x1b\\question\x1b]8;;\x1b\\", "next question"],
  ["a\x1b[2Jb\x1b]0;hidden title\x07c\x1bPprivate payload\x1b\\d", "abcd"],
  ["a\x00b\x07c\x08d\x7fe\x80f\u200bg\u202eh\u2066i", "abcdefghi"],
  ["\u009b31mhello\u009b0m", "hello"],
  ["a\u009d0;hidden title\u009cb\u0090hidden payload\u009cc", "abc"],
  ["👨‍👩‍👧‍👦 中文 café", "👨‍👩‍👧‍👦 中文 café"],
]) {
  test(`suggestions sanitize ${JSON.stringify(input)}`, () => {
    const suggestions = new InputSuggestions(() => {})
    suggestions.api("ext").setInputSuggestion(input!)
    expect(suggestions.text).toBe(expected)
  })
}

test("suggestions strip all bidi controls, including Arabic letter mark, without breaking ZWJ emoji", () => {
  const suggestions = new InputSuggestions(() => {})
  const api = suggestions.api("ext")
  const accepted: string[] = []
  api.onInputSuggestionAccepted((text) => accepted.push(text))
  const controls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
  api.setInputSuggestion(`safe${controls}123 👨‍👩‍👧‍👦`)
  expect(suggestions.text).toBe("safe123 👨‍👩‍👧‍👦")
  expect(suggestions.text).not.toMatch(/\p{Bidi_Control}/u)
  expect(suggestions.accept()).toBe("safe123 👨‍👩‍👧‍👦")
  expect(accepted).toEqual(["safe123 👨‍👩‍👧‍👦"])
})

test("suggestions cap Unicode code points, not UTF-16 units, and stay trimmed after truncation", () => {
  const suggestions = new InputSuggestions(() => {})
  const api = suggestions.api("ext")
  api.setInputSuggestion("😀".repeat(501))
  expect(suggestions.text).toBe("😀".repeat(500))
  expect(Array.from(suggestions.text!).length).toBe(500)
  api.setInputSuggestion(`${"a".repeat(499)} b`)
  expect(suggestions.text).toBe("a".repeat(499))
})

test("latest setter owns the slot; undefined and sanitized-empty clears are owner-only", () => {
  const suggestions = new InputSuggestions(() => {})
  const a = suggestions.api("a")
  const b = suggestions.api("b")
  a.setInputSuggestion("first")
  b.setInputSuggestion("second")
  a.setInputSuggestion(undefined)
  a.setInputSuggestion("\x1b[0m\x00\n\t")
  expect(suggestions.text).toBe("second")
  b.setInputSuggestion("  ")
  expect(suggestions.text).toBeUndefined()
  a.setInputSuggestion("third")
  b.setInputSuggestion("third")
  a.setInputSuggestion(undefined)
  expect(suggestions.text).toBe("third")
  b.setInputSuggestion(undefined)
  expect(suggestions.text).toBeUndefined()
})

test("host clear is unconditional, silent, and does not restore replaced suggestions", () => {
  let renders = 0
  const suggestions = new InputSuggestions(() => renders++)
  const accepted: string[] = []
  const a = suggestions.api("a")
  a.onInputSuggestionAccepted((text) => accepted.push(text))
  a.setInputSuggestion("first")
  suggestions.api("b").setInputSuggestion("second")
  suggestions.clear()
  expect(suggestions.text).toBeUndefined()
  expect(suggestions.accept()).toBeUndefined()
  suggestions.clear()
  expect(renders).toBe(3)
  expect(accepted).toEqual([])
})

test("accept takes before callbacks, notifies only the owner, and preserves reentrant setters", () => {
  const suggestions = new InputSuggestions(() => {})
  const a = suggestions.api("a")
  const b = suggestions.api("b")
  const accepted: string[] = []
  a.onInputSuggestionAccepted((text) => accepted.push(`a:${text}`))
  b.onInputSuggestionAccepted((text) => {
    expect(suggestions.text).toBeUndefined()
    expect(suggestions.accept()).toBeUndefined()
    accepted.push(`b:${text}`)
    b.setInputSuggestion("follow-up")
  })
  a.setInputSuggestion("superseded")
  b.setInputSuggestion("  take\nthis  ")
  expect(suggestions.accept()).toBe("take this")
  expect(accepted).toEqual(["b:take this"])
  expect(suggestions.text).toBe("follow-up")
})

test("accept isolates throwing and rejecting callbacks; unsubscribe is idempotent", async () => {
  const suggestions = new InputSuggestions(() => {})
  const api = suggestions.api()
  const accepted: string[] = []
  const off = api.onInputSuggestionAccepted(() => accepted.push("unsubscribed"))
  off()
  off()
  api.onInputSuggestionAccepted(() => {
    throw new Error("broken listener")
  })
  api.onInputSuggestionAccepted(async () => {
    throw new Error("rejected listener")
  })
  api.onInputSuggestionAccepted((text) => accepted.push(text))
  api.setInputSuggestion("safe")
  expect(suggestions.accept()).toBe("safe")
  expect(suggestions.accept()).toBeUndefined()
  await Bun.sleep(0)
  expect(accepted).toEqual(["safe"])
})

test("release clears owned state and callbacks, fences stale handles, and permits a fresh load", () => {
  const suggestions = new InputSuggestions(() => {})
  const stale = suggestions.api("a")
  const accepted: string[] = []
  stale.onInputSuggestionAccepted((text) => accepted.push(`stale:${text}`))
  stale.setInputSuggestion("before unload")
  suggestions.release("b")
  expect(suggestions.text).toBe("before unload")
  suggestions.release("a")
  expect(suggestions.text).toBeUndefined()
  const fresh = suggestions.api("a")
  fresh.onInputSuggestionAccepted((text) => accepted.push(`fresh:${text}`))
  fresh.setInputSuggestion("after reload")
  stale.setInputSuggestion("late prediction")
  stale.setInputSuggestion(undefined)
  stale.onInputSuggestionAccepted(() => accepted.push("late registration"))()
  expect(suggestions.accept()).toBe("after reload")
  expect(accepted).toEqual(["fresh:after reload"])
})

test("release of another owner cannot clear the current suggestion", () => {
  const suggestions = new InputSuggestions(() => {})
  suggestions.api("a").setInputSuggestion("old")
  suggestions.api("b").setInputSuggestion("current")
  suggestions.release("a")
  expect(suggestions.text).toBe("current")
})

test("listeners unsubscribed or released during acceptance do not run", () => {
  const suggestions = new InputSuggestions(() => {})
  const api = suggestions.api("a")
  const accepted: string[] = []
  api.onInputSuggestionAccepted(() => suggestions.release("a"))
  api.onInputSuggestionAccepted((text) => accepted.push(text))
  api.setInputSuggestion("take")
  expect(suggestions.accept()).toBe("take")
  expect(accepted).toEqual([])
})

test("a setter arriving while already busy drops the prediction and any old slot", () => {
  let busy = false
  const suggestions = new InputSuggestions(
    () => {},
    () => busy,
  )
  suggestions.api("a").setInputSuggestion("old idle prediction")
  busy = true
  suggestions.api("b").setInputSuggestion("late busy prediction")
  expect(suggestions.text).toBeUndefined()
  busy = false
  expect(suggestions.text).toBeUndefined()
  suggestions.api("b").setInputSuggestion("new idle prediction")
  expect(suggestions.text).toBe("new idle prediction")
})

test("UiRequests exposes local methods and emits only empty ui.render events", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const ui = new UiRequests(bus, { sessionId: "main" })
  const first = ui.api("ext")
  const second = ui.api("ext")
  const accepted: string[] = []
  first.onInputSuggestionAccepted((text) => accepted.push(text))
  second.setInputSuggestion("private suggestion")
  expect(ui.inputSuggestions.accept()).toBe("private suggestion")
  expect(accepted).toEqual(["private suggestion"])
  await bus.flush()
  expect(events.map(({ type, data, sessionId }) => ({ type, data, sessionId }))).toEqual([
    { type: "ui.render", data: {}, sessionId: "main" },
    { type: "ui.render", data: {}, sessionId: "main" },
  ])
  expect(ui.pending).toEqual([])
})

function hostSetup(bus = new EventBus(), sessionId?: string, ui?: UiRequests) {
  return new ExtensionHost({
    bus,
    sessionId,
    ui,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
}

test("extension unload and failed load release suggestions and invalidate retained UI handles", async () => {
  const host = hostSetup()
  const handles: UiApi[] = []
  const accepted: string[] = []
  const load = (fail = false) =>
    host.load((api) => {
      handles.push(api.ui)
      api.ui.onInputSuggestionAccepted((text) => accepted.push(text))
      api.ui.setInputSuggestion("extension prediction")
      if (fail) throw new Error("load failed")
    }, "ext")
  expect(await load()).toBe(true)
  expect(host.ui.inputSuggestions.text).toBe("extension prediction")
  expect(host.unload("ext")).toBe(true)
  handles[0]!.setInputSuggestion("late after unload")
  expect(host.ui.inputSuggestions.text).toBeUndefined()
  expect(await load(true)).toBe(false)
  handles[1]!.setInputSuggestion("late after failed load")
  expect(host.ui.inputSuggestions.text).toBeUndefined()
  expect(await load()).toBe(true)
  expect(host.ui.inputSuggestions.accept()).toBe("extension prediction")
  expect(accepted).toEqual(["extension prediction"])
  host.unloadAll()
})

test("host clears synchronously on main lifecycle events, not child or unrelated sessions", () => {
  const bus = new EventBus()
  const host = hostSetup(bus, "main")
  const set = () => host.ui.api("ext").setInputSuggestion("prediction")
  set()
  bus.emit(
    "turn.start",
    { prompt: { role: "user", content: [] } },
    { sessionId: "child", parentSessionId: "main" },
  )
  bus.emit("status.changed", { status: "working" }, { sessionId: "other" })
  bus.emit("session.end", { reason: "switch" }, { sessionId: "child", parentSessionId: "main" })
  expect(host.ui.inputSuggestions.text).toBe("prediction")
  bus.emit("status.changed", { status: "idle" }, { sessionId: "main" })
  expect(host.ui.inputSuggestions.text).toBe("prediction")
  bus.emit("turn.start", { prompt: { role: "user", content: [] } }, { sessionId: "main" })
  expect(host.ui.inputSuggestions.text).toBeUndefined()
  for (const status of ["working", "blocked"] as const) {
    set()
    bus.emit("status.changed", { status }, { sessionId: "main" })
    expect(host.ui.inputSuggestions.text).toBeUndefined()
  }
  set()
  bus.emit(
    "session.start",
    { reason: "clear", cwd: "/workspace", model: { provider: "mock", model: "m" } },
    { sessionId: "main" },
  )
  expect(host.ui.inputSuggestions.text).toBeUndefined()
  set()
  bus.emit("session.end", { reason: "switch" }, { sessionId: "main" })
  expect(host.ui.inputSuggestions.text).toBeUndefined()
})

test("active-agent accessor follows switches, fences busy setters, and clears at hold acquisition", async () => {
  const gate = Promise.withResolvers<void>()
  const ai = createAi({
    dialects: [createMockDialect([{ text: "done", hold: { chunks: 0, until: gate.promise } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  const first = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "", bus })
  const second = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "", bus })
  const ui = new UiRequests(bus)
  const host = hostSetup(bus, undefined, ui)
  const commands = new CommandHost({
    registry: new CommandRegistry(),
    bus,
    ui,
    control: {} as SessionControl,
    agent: first,
  })
  host.setSessionControl(commands.control, () => commands.agent)
  const api = ui.api("ext")
  try {
    api.setInputSuggestion("before switch")
    commands.switchTo(second)
    expect(ui.inputSuggestions.text).toBeUndefined()
    api.setInputSuggestion("after switch")
    first.start("clear")
    expect(ui.inputSuggestions.text).toBe("after switch")
    const holdGate = Promise.withResolvers<void>()
    const held = second.hold("test", () => holdGate.promise)
    expect(ui.inputSuggestions.text).toBeUndefined()
    api.setInputSuggestion("late during hold")
    expect(ui.inputSuggestions.text).toBeUndefined()
    holdGate.resolve()
    await held
    api.setInputSuggestion("before turn")
    const running = second.prompt("go")
    expect(ui.inputSuggestions.text).toBeUndefined()
    api.setInputSuggestion("late during turn")
    expect(ui.inputSuggestions.text).toBeUndefined()
    gate.resolve()
    await running
    api.setInputSuggestion("after turn")
    expect(ui.inputSuggestions.text).toBe("after turn")
    expect(ui.inputSuggestions.accept()).toBe("after turn")
  } finally {
    gate.resolve()
    await first.dispose()
    await second.dispose()
  }
})
