import { expect, test } from "bun:test"
import { type AnyEvent, type EventMap, type ExtensionAPI, type TerminalProgress, textCells } from "@amira/api"
import extension from "../src/index.ts"

async function setup() {
  const titles: string[] = []
  const progress: TerminalProgress[] = []
  let bells = 0
  let ts = 0
  const handlers = new Map<string, (event: AnyEvent) => void>()
  await extension({
    terminal: {
      setTitle: (title: string) => titles.push(title),
      setProgress: (state: TerminalProgress) => progress.push(state),
      bell: () => bells++,
    },
    on: (type: string, handler: (event: AnyEvent) => void) => {
      handlers.set(type, handler)
      return () => {}
    },
  } as unknown as ExtensionAPI)
  const emit = <K extends keyof EventMap>(
    type: K,
    data: EventMap[K],
    sessionId = "main",
    parentSessionId?: string,
  ) => {
    handlers.get(type)?.({ type, data, sessionId, parentSessionId, ts, seq: 1 } as AnyEvent)
  }
  emit("session.start", {
    reason: "startup",
    cwd: "/work/proj",
    title: "Database repair",
    model: { provider: "mock", model: "m" },
  })
  return {
    emit,
    titles,
    progress,
    bells: () => bells,
    advance: (ms: number) => {
      ts += ms
    },
  }
}
const prompt = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] }

test("titles use the session title or cwd name, with a working marker and no duplicate workspace details", async () => {
  const s = await setup()
  s.emit("workspace.changed", { cwd: "/work/proj", branch: "main" })
  s.emit("turn.start", { prompt })
  s.emit("turn.end", { reason: "done", steps: 1 })
  expect(s.titles).toEqual([
    "Amira · Database repair",
    "● Amira · Database repair",
    "Amira · Database repair",
  ])
  s.emit("session.title", { title: "  New\nname  " })
  expect(s.titles.at(-1)).toBe("Amira · New name")
  // Without a title the cwd's final component is the fallback, on either path convention.
  s.emit(
    "session.start",
    { reason: "clear", cwd: "/work/proj", model: { provider: "mock", model: "m" } },
    "new",
  )
  expect(s.titles.at(-1)).toBe("Amira · proj")
  s.emit(
    "session.start",
    { reason: "resume", cwd: "C:\\work\\next\\", model: { provider: "mock", model: "m" } },
    "next",
  )
  expect(s.titles.at(-1)).toBe("Amira · next")
  s.emit(
    "session.start",
    { reason: "startup", cwd: "/child", model: { provider: "mock", model: "m" } },
    "child",
    "next",
  )
  s.emit("turn.start", { prompt }, "child", "next")
  expect(s.titles.at(-1)).toBe("Amira · next")
})

test("title truncation keeps the exact cell limits", async () => {
  const s = await setup()
  s.emit("session.start", {
    reason: "startup",
    cwd: `/work/${"界".repeat(40)}`,
    title: "s".repeat(90),
    model: { provider: "mock", model: "m" },
  })
  expect(s.titles.at(-1)).toBe(`Amira · ${"s".repeat(63)}…`)
  s.emit("workspace.changed", { cwd: "/work/proj", branch: "b".repeat(90) })
  s.emit("turn.start", { prompt })
  expect(textCells(s.titles.at(-1)!)).toBeLessThanOrEqual(128)
  s.emit("session.start", { reason: "clear", cwd: "/proj", model: { provider: "mock", model: "m" } })
  s.emit("workspace.changed", { cwd: "/proj", branch: "b".repeat(90) })
  expect(s.titles.at(-1)).toBe("Amira · proj")
  s.emit("session.start", {
    reason: "clear",
    cwd: `/work/${"界".repeat(40)}`,
    model: { provider: "mock", model: "m" },
  })
  expect(s.titles.at(-1)).toBe(`Amira · ${"界".repeat(31)}…`)
})

test("waiting takes priority over working but hidden openings never ring while focused", async () => {
  const s = await setup()
  s.emit("ui.focus", { focused: true }, "host")
  s.emit("turn.start", { prompt })
  s.emit("ui.waiting", { pending: 1, hidden: true, change: "opened" }, "host")
  s.emit("ui.waiting", { pending: 1, hidden: false, change: "visibility" }, "host")
  expect(s.bells()).toBe(0)
  s.emit("ui.waiting", { pending: 2, hidden: true, change: "opened" }, "host")
  expect(s.bells()).toBe(0)
  s.emit("ui.waiting", { pending: 0, hidden: false, change: "resolved" }, "host")
  s.emit("turn.end", { reason: "done", steps: 1 })
  expect(s.progress).toEqual(["none", "indeterminate", "paused", "paused", "paused", "indeterminate", "none"])
  expect(s.bells()).toBe(0)
})

test("known focus controls completion and question bells; aborted turns never ring", async () => {
  const s = await setup()
  s.emit("ui.focus", { focused: true }, "host")
  s.emit("turn.start", { prompt })
  s.advance(20_000)
  s.emit("turn.end", { reason: "done", steps: 1 })
  expect(s.bells()).toBe(0)
  s.emit("ui.focus", { focused: false }, "host")
  s.emit("turn.start", { prompt })
  s.emit("ui.waiting", { pending: 1, hidden: false, change: "opened" }, "host")
  s.emit("ui.waiting", { pending: 0, hidden: false, change: "resolved" }, "host")
  s.emit("turn.end", { reason: "error", steps: 1 })
  expect(s.bells()).toBe(2)
  s.emit("turn.start", { prompt })
  s.emit("turn.end", { reason: "aborted", steps: 1 })
  expect(s.bells()).toBe(2)
})

test("unknown focus requests question alerts immediately, never long-turn completion alerts", async () => {
  const s = await setup()
  s.emit("turn.start", { prompt })
  s.advance(14_999)
  s.emit("turn.end", { reason: "done", steps: 1 })
  expect(s.bells()).toBe(0)
  s.emit("turn.start", { prompt })
  s.advance(15_000)
  s.emit("ui.waiting", { pending: 1, hidden: false, change: "opened" }, "host")
  expect(s.bells()).toBe(1)
  s.emit("ui.waiting", { pending: 0, hidden: false, change: "resolved" }, "host")
  s.emit("turn.end", { reason: "done", steps: 1 })
  expect(s.bells()).toBe(1)
  s.emit("ui.waiting", { pending: 1, hidden: false, change: "opened" }, "host")
  expect(s.bells()).toBe(2)
  s.emit("ui.focus", { focused: false }, "host")
  expect(s.bells()).toBe(3) // The frontend deduplicates this focus-change request.
})
