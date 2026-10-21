import { expect, spyOn, test } from "bun:test"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InputSuggestions } from "../src/input-suggestions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

function fixture() {
  let revision = 0
  let ready = true
  let busy = false
  const suggestions = new InputSuggestions(
    () => {},
    () => busy,
  )
  const detach = suggestions.attach(() => ({ revision, ready }))
  const api = suggestions.api("prediction")
  return {
    suggestions,
    api,
    detach,
    edit() {
      revision++
      suggestions.refresh()
    },
    block() {
      ready = false
      suggestions.refresh()
    },
    busy() {
      busy = true
      suggestions.clear()
    },
  }
}

test("slots require an explicitly attached ready local composer, not just an idle host", () => {
  // Print, headless, RPC, remote and child hosts never attach a local composer.
  for (const mode of ["print", "headless", "rpc", "remote", "subagent"]) {
    const ui = new UiRequests(new EventBus(), { sessionId: mode })
    expect(ui.api("predict").acquireInputSuggestionSlot()).toBeUndefined()
  }
  const s = fixture()
  expect(s.api.acquireInputSuggestionSlot()).toBeDefined()
  s.block()
  expect(s.api.acquireInputSuggestionSlot()).toBeUndefined()
  s.detach()
  expect(s.api.acquireInputSuggestionSlot()).toBeUndefined()
})

test("slot setters sanitize identically, preserve acceptance ownership and release safely", () => {
  const s = fixture()
  const accepted: string[] = []
  s.api.onInputSuggestionAccepted((text) => accepted.push(text))
  const slot = s.api.acquireInputSuggestionSlot()!
  expect(slot.set("  \x1b[31mTry\x1b[0m\n tests  ")).toBe(true)
  expect(s.suggestions.text).toBe("Try tests")
  expect(s.suggestions.accept()).toBe("Try tests")
  expect(slot.signal.aborted).toBe(true)
  expect(accepted).toEqual(["Try tests"])
  expect(slot.set("late")).toBe(false)
  expect(s.suggestions.text).toBeUndefined()

  const next = s.api.acquireInputSuggestionSlot()!
  expect(next.set("😀".repeat(501))).toBe(true)
  expect(s.suggestions.text).toBe("😀".repeat(500))
  expect(next.set("\x00\n ")).toBe(true)
  expect(s.suggestions.text).toBeUndefined()
  next.set("release me")
  next.release()
  next.release()
  expect(next.signal.aborted).toBe(true)
  expect(next.set("late")).toBe(false)
  expect(s.suggestions.text).toBeUndefined()
})

for (const trigger of ["edit", "block", "busy", "detach"] as const) {
  test(`${trigger} aborts both a pending prediction and an already displayed slot`, () => {
    for (const displayed of [false, true]) {
      const s = fixture()
      const slot = s.api.acquireInputSuggestionSlot()!
      if (displayed) slot.set("prediction")
      let aborted = 0
      slot.signal.addEventListener("abort", () => aborted++)
      s[trigger]()
      expect(aborted).toBe(1)
      expect(slot.signal.aborted).toBe(true)
      expect(slot.set("stale")).toBe(false)
      expect(s.suggestions.text).toBeUndefined()
    }
  })
}

test("a monotonic revision fences type-then-delete even when readiness and emptiness return", () => {
  let revision = 0
  const suggestions = new InputSuggestions(() => {})
  suggestions.attach(() => ({ revision, ready: true }))
  const api = suggestions.api("predict")
  const slot = api.acquireInputSuggestionSlot()!
  revision += 2
  // Even before a scheduled frontend refresh, set must recheck the revision.
  expect(slot.set("stale after deletion")).toBe(false)
  expect(slot.signal.aborted).toBe(true)
  expect(api.acquireInputSuggestionSlot()!.set("fresh")).toBe(true)
  expect(suggestions.text).toBe("fresh")
})

test("new acquisition replaces only that extension's lease; old releases cannot clear newer owners", () => {
  const s = fixture()
  const old = s.api.acquireInputSuggestionSlot()!
  old.set("first")
  const other = s.suggestions.api("other").acquireInputSuggestionSlot()!
  other.set("other")
  const next = s.api.acquireInputSuggestionSlot()!
  expect(old.signal.aborted).toBe(true)
  expect(other.signal.aborted).toBe(false)
  expect(s.suggestions.text).toBe("other")
  next.set("next")
  old.release()
  other.release()
  expect(s.suggestions.text).toBe("next")
  s.suggestions.release("prediction")
  expect(next.signal.aborted).toBe(true)
  expect(next.set("unloaded")).toBe(false)
  expect(s.api.acquireInputSuggestionSlot()).toBeUndefined()
  expect(s.suggestions.text).toBeUndefined()
  const reloaded = s.suggestions.api("prediction").acquireInputSuggestionSlot()!
  expect(reloaded.signal.aborted).toBe(false)
  reloaded.release()
})

test("abort listeners cannot acquire an unfenced lease during replacement or invalidation", () => {
  const s = fixture()
  const old = s.api.acquireInputSuggestionSlot()!
  old.signal.addEventListener("abort", () => {
    expect(s.api.acquireInputSuggestionSlot()).toBeUndefined()
  })
  const next = s.api.acquireInputSuggestionSlot()!
  expect(old.signal.aborted).toBe(true)
  expect(next.set("fresh")).toBe(true)
  next.signal.addEventListener("abort", () => {
    expect(s.api.acquireInputSuggestionSlot()).toBeUndefined()
  })
  s.edit()
  expect(next.signal.aborted).toBe(true)
})

test("frontend replacement aborts old leases and an old detach cannot detach its replacement", () => {
  const s = fixture()
  const old = s.api.acquireInputSuggestionSlot()!
  const detach = s.suggestions.attach(() => ({ revision: 0, ready: true }))
  expect(old.signal.aborted).toBe(true)
  const next = s.api.acquireInputSuggestionSlot()!
  s.detach()
  expect(next.signal.aborted).toBe(false)
  detach()
  expect(next.signal.aborted).toBe(true)
})

for (const kind of ["input", "confirm", "form"] as const) {
  test(`${kind} invalidates synchronously before its event is delivered`, async () => {
    const ui = new UiRequests(new EventBus())
    ui.inputSuggestions.attach(() => ({ revision: 0, ready: true }))
    const api = ui.api("predict")
    const slot = api.acquireInputSuggestionSlot()!
    slot.set("prediction")
    const answer = kind === "form" ? api.form({ title: "Form", fields: [] }) : api[kind]("Dialog")
    expect(slot.signal.aborted).toBe(true)
    expect(slot.set("stale")).toBe(false)
    expect(api.acquireInputSuggestionSlot()).toBeUndefined()
    expect(ui.inputSuggestions.text).toBeUndefined()
    ui.cancelAll()
    await answer
    expect(api.acquireInputSuggestionSlot()).toBeDefined()
  })
}

test("stable readers have distinct attachment lifetimes", () => {
  const suggestions = new InputSuggestions(() => {})
  const read = () => ({ revision: 0, ready: true })
  const detachOld = suggestions.attach(read)
  const detachNew = suggestions.attach(read)
  const slot = suggestions.api("ext").acquireInputSuggestionSlot()!
  detachOld()
  expect(slot.signal.aborted).toBe(false)
  expect(slot.set("still attached")).toBe(true)
  detachNew()
  expect(slot.signal.aborted).toBe(true)
})

test("attachment and detach preserve legacy setters made before a frontend connects", () => {
  const suggestions = new InputSuggestions(() => {})
  suggestions.api("legacy").setInputSuggestion("startup suggestion")
  const detach = suggestions.attach(() => ({ revision: 0, ready: true }))
  expect(suggestions.text).toBe("startup suggestion")
  detach()
  expect(suggestions.text).toBe("startup suggestion")
})

test("slot-abort cancellation cannot publish or subscribe an already settled live dialog", async () => {
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  ui.inputSuggestions.attach(() => ({ revision: 0, ready: true }))
  const api = ui.api("prediction")
  const slot = api.acquireInputSuggestionSlot()!
  const events: string[] = []
  bus.capture(
    (event) => events.push(event.type),
    () => {},
  )
  const subscribe = spyOn(bus, "subscribe")
  try {
    const answer = api.choose("Pick", ["one"], {
      sections: [],
      live: () => ({}),
      signal: slot.signal,
    })
    expect(await answer).toBeUndefined()
    expect(slot.signal.aborted).toBe(true)
    expect(ui.pending).toEqual([])
    expect(subscribe).not.toHaveBeenCalled()
    expect(events).not.toContain("ui.request")
    expect(events).toContain("ui.resolved")
  } finally {
    subscribe.mockRestore()
  }
})

test("main lifecycle events abort slots synchronously, while child events leave them valid", () => {
  const bus = new EventBus()
  const host = new ExtensionHost({
    bus,
    sessionId: "main",
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  host.ui.inputSuggestions.attach(() => ({ revision: 0, ready: true }))
  const api = host.ui.api("predict")
  let slot = api.acquireInputSuggestionSlot()!
  bus.emit(
    "turn.start",
    { prompt: { role: "user", content: [] } },
    { sessionId: "child", parentSessionId: "main" },
  )
  expect(slot.signal.aborted).toBe(false)
  const events = [
    () => bus.emit("turn.start", { prompt: { role: "user", content: [] } }, { sessionId: "main" }),
    () => bus.emit("status.changed", { status: "working" }, { sessionId: "main" }),
    () => bus.emit("status.changed", { status: "blocked" }, { sessionId: "main" }),
    () =>
      bus.emit(
        "session.start",
        { reason: "clear", cwd: "/work", model: { provider: "mock", model: "m" } },
        { sessionId: "main" },
      ),
    () => bus.emit("session.end", { reason: "switch" }, { sessionId: "main" }),
  ]
  for (const emit of events) {
    slot = api.acquireInputSuggestionSlot()!
    slot.set("prediction")
    emit()
    expect(slot.signal.aborted).toBe(true)
    expect(slot.set("late")).toBe(false)
    expect(host.ui.inputSuggestions.text).toBeUndefined()
  }
})

test("slot invalidation leaves legacy suggestions and newer setters alone", () => {
  const s = fixture()
  const slot = s.api.acquireInputSuggestionSlot()!
  slot.set("leased")
  s.api.setInputSuggestion("legacy")
  s.edit()
  expect(slot.signal.aborted).toBe(true)
  expect(s.suggestions.text).toBe("legacy")
})
