import { expect, test } from "bun:test"
import { type AnyEvent, PANEL_MAX_LINES, type PanelRenderOptions } from "@amira/api"
import { EventBus, ExtensionHost, InterceptorRegistry, PanelRegistry, ToolRegistry } from "../src/index.ts"

const opts = (o: Partial<PanelRenderOptions> = {}): PanelRenderOptions => ({
  width: 80,
  now: 0,
  sessionId: "s1",
  collapsed: false,
  ...o,
})

test("panels come in order, empty and failing ones are left out, text is made safe", () => {
  const r = new PanelRegistry()
  r.register({ id: "b", order: 1, render: () => [{ kind: "text", text: "b1" }] })
  r.register({ id: "a", render: (o) => [{ kind: "accent", text: `a for ${o.sessionId}\x1b[31m\nx` }] })
  r.register({ id: "empty", render: () => [] })
  r.register({
    id: "throws",
    render: () => {
      throw new Error("no")
    },
  })
  r.register({ id: "junk", render: () => "nope" as never })
  r.register({
    id: "odd",
    order: 2,
    render: () => [{ kind: "sparkly" as never, text: "odd" }, null as never],
  })
  expect(r.snapshot(opts())).toEqual([
    { id: "a", lines: [{ kind: "accent", text: "a for s1 [31m x" }] },
    { id: "b", lines: [{ kind: "text", text: "b1" }] },
    { id: "odd", lines: [{ kind: "text", text: "odd" }] },
  ])
})

test("panels preserve semantic segments and user messages while sanitizing their text", () => {
  const r = new PanelRegistry()
  r.register({
    id: "semantic",
    render: () => [
      {
        kind: "segments",
        parts: [
          { kind: "accent", text: "Title\n " },
          { kind: "muted", text: "detail\x07" },
          { kind: "code" as never, text: "fallback" },
          null as never,
          { kind: "text", text: 5 as never },
        ],
      },
      { kind: "user-message", text: "hello\nworld  ", note: "sent\tthen  " },
      { kind: "segments", parts: null as never },
    ],
  })
  expect(r.snapshot(opts())[0]!.lines).toEqual([
    {
      kind: "segments",
      parts: [
        { kind: "accent", text: "Title  " },
        { kind: "muted", text: "detail " },
        { kind: "text", text: "fallback" },
      ],
    },
    { kind: "user-message", text: "hello world", note: "sent then" },
  ])
  expect(r.snapshot(opts({ collapsed: true }))[0]!.lines).toHaveLength(1)
})

test("a collapsed panel keeps its first line; a long one is cut with a count", () => {
  const r = new PanelRegistry()
  const lines = Array.from({ length: 20 }, (_, i) => ({ kind: "text" as const, text: `l${i}` }))
  r.register({ id: "long", render: () => lines })
  expect(r.snapshot(opts({ collapsed: true }))[0]!.lines).toEqual([{ kind: "text", text: "l0" }])
  const cut = r.snapshot(opts())[0]!.lines
  expect(cut).toHaveLength(PANEL_MAX_LINES)
  expect(cut.at(-1)).toEqual({ kind: "muted", text: `… ${20 - PANEL_MAX_LINES + 1} more` })
})

test("an id holds a stack: override replaces, removing restores; a taken id is refused", () => {
  const r = new PanelRegistry()
  const offA = r.register({ id: "p", render: () => [{ kind: "text", text: "first" }] })
  expect(() => r.register({ id: "p", render: () => [] })).toThrow(/already registered/)
  const offB = r.register({ id: "p", override: true, render: () => [{ kind: "text", text: "second" }] })
  expect(r.snapshot(opts())[0]!.lines[0]).toEqual({ kind: "text", text: "second" })
  offB()
  expect(r.snapshot(opts())[0]!.lines[0]).toEqual({ kind: "text", text: "first" })
  offA()
  expect(r.size).toBe(0)
})

test("extensions register panels through the API; a taken id is reported and unloading removes it", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load((api) => {
    api.registerPanel({ id: "todo", render: () => [{ kind: "text", text: "one" }] })
  }, "a")
  await host.load((api) => {
    api.registerPanel({ id: "todo", render: () => [] })
  }, "b")
  await bus.flush()
  expect(host.loaded).toEqual(["a", "b"])
  expect(events.some((e) => e.type === "extension.error" && /already registered/.test(e.data.error))).toBe(
    true,
  )
  expect(host.panels.snapshot(opts())).toEqual([{ id: "todo", lines: [{ kind: "text", text: "one" }] }])
  host.unload("a")
  expect(host.panels.size).toBe(0)
})
