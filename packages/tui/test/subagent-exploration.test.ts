import { expect, test } from "bun:test"
import { type ExtensionAPI, emptyUsage, type Message, type SubagentInfo, textResult } from "@amira/api"
import { monoTheme, stripAnsi } from "@amira/tui-kit"
import { subagentView } from "../../../extensions/agent/src/subagent-view.ts"
import { ExtensionViewer } from "../src/extension-view.ts"

function fixture(messages: Message[]) {
  const info: SubagentInfo = {
    id: "child",
    parentSessionId: "main",
    depth: 1,
    role: "explorer",
    title: "Check files",
    task: "Check files",
    status: "running",
    usage: emptyUsage(),
  }
  const list = [info]
  const api = {
    session: () => ({ subagents: () => list, subagentMessages: () => messages }),
    on: () => () => {},
    requestRender: () => {},
  } as unknown as ExtensionAPI
  const definition = subagentView(api)
  const data = { sessionId: "child" }
  const viewer = new ExtensionViewer(definition, data, { now: () => 1000 })
  const render = () => viewer.render(100, { theme: monoTheme, color: false, rows: 80 }).map(stripAnsi)
  const assistant = (content: Extract<Message, { role: "assistant" }>["content"]): Message => ({
    role: "assistant",
    model: { provider: "mock", model: "m1" },
    content,
  })
  const result = (
    id: string,
    name: string,
    text: string,
    isError = false,
  ): Extract<Message, { role: "toolResult" }> => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    ...textResult(text, isError),
    isError,
  })
  return { definition, data, viewer, render, assistant, result, list }
}

const toggle = { type: "key", name: "o", ctrl: true, alt: false, shift: false } as const

test("/agents groups calls across steps, counts repeat targets and unfolds with Ctrl+O without a summary", () => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Check files" }] }]
  const s = fixture(messages)
  messages.push(
    s.assistant([{ type: "toolCall", id: "a", name: "read", args: { path: "a.ts" } }]),
    s.result("a", "read", "first result\nfirst body"),
    s.assistant([
      { type: "toolCall", id: "b", name: "read", args: { path: "a.ts" } },
      { type: "serverTool", id: "search", name: "web_search", input: { query: "TODO" }, status: "done" },
      { type: "text", text: "Finished checking." },
    ]),
    s.result("b", "read", "second result\nsecond body"),
  )
  const folded = s.render()
  expect(folded).toContain("  └ Read 2 files · Searched 1 pattern  ▸")
  expect(folded.join("\n")).not.toContain("Explored")
  expect(folded.join("\n")).not.toContain("first result")
  expect(s.viewer.handleInput(toggle)).toBe(true)
  const full = s.render()
  expect(full.filter((row) => row === "  ├ read a.ts")).toHaveLength(2)
  expect(full).toContain("  └ web_search TODO")
  expect(full.join("\n")).toContain("first result")
  expect(full.join("\n")).toContain("first body")
  expect(full.join("\n")).toContain("second result")
  expect(full.join("\n")).toContain("second body")
  expect(full.join("\n")).not.toContain("Read 2 files")
  expect(full.join("\n")).not.toContain("▸")
  expect(full.indexOf("  Finished checking.")).toBeGreaterThan(full.indexOf("  └ web_search TODO"))
  s.viewer.handleInput(toggle)
  expect(s.render()).toContain("  └ Read 2 files · Searched 1 pattern  ▸")
})

test("/agents keeps errors, rejections, edits and commands between successful runs", () => {
  const messages: Message[] = []
  const s = fixture(messages)
  messages.push(
    s.assistant([
      { type: "toolCall", id: "a", name: "read", args: { path: "a.ts" } },
      { type: "toolCall", id: "b", name: "read", args: { path: "b.ts" } },
      { type: "toolCall", id: "bad", name: "read", args: { path: "missing.ts" } },
      { type: "toolCall", id: "blocked", name: "read", args: { path: "blocked.ts" } },
      { type: "toolCall", id: "edit", name: "edit", args: { path: "a.ts" } },
      { type: "toolCall", id: "command", name: "bash", args: { command: "check" } },
      { type: "toolCall", id: "c", name: "read", args: { path: "c.ts" } },
      { type: "toolCall", id: "d", name: "read", args: { path: "d.ts" } },
    ]),
    s.result("a", "read", "first"),
    s.result("b", "read", "second"),
    s.result("bad", "read", "missing", true),
    { ...s.result("blocked", "read", "denied"), rejected: "blocked" },
    s.result("edit", "edit", "changed"),
    s.result("command", "bash", "checked"),
    s.result("c", "read", "third"),
    s.result("d", "read", "fourth"),
  )
  const rows = s.render()
  const first = rows.indexOf("  ├ Read 2 files  ▸")
  const last = rows.indexOf("  └ Read 2 files  ▸")
  expect(first).toBeGreaterThanOrEqual(0)
  expect(last).toBeGreaterThan(first)
  expect(rows.slice(first + 1, last)).toEqual([
    "  ├ read missing.ts  ✗ missing",
    "  ├ read blocked.ts  ⊘ denied",
    "  ├ edit a.ts  ✓ changed",
    "  ├ bash check  ✓ checked",
  ])
})

test("/agents does not batch over running calls, replies or associated children and keeps the fallback", () => {
  const messages: Message[] = []
  const s = fixture(messages)
  s.list.push({
    ...s.list[0]!,
    id: "nested",
    parentSessionId: "child",
    depth: 2,
    toolCallId: "agent",
    title: "Nested check",
  })
  messages.push(
    s.assistant([
      { type: "toolCall", id: "a", name: "read", args: { path: "a.ts" } },
      { type: "toolCall", id: "live", name: "read", args: { path: "live.ts" } },
      { type: "toolCall", id: "b", name: "read", args: { path: "b.ts" } },
      { type: "text", text: "Next step." },
      { type: "toolCall", id: "agent", name: "agent", args: { tasks: [] } },
      { type: "toolCall", id: "c", name: "read", args: { path: "c.ts" } },
    ]),
    s.result("a", "read", "first"),
    s.result("b", "read", "second"),
    s.result("agent", "agent", "started"),
    s.result("c", "read", "third"),
  )
  const batches: { names: string[]; last?: boolean; detail: string }[] = []
  const rows = s.definition.render!(s.data, {
    width: 100,
    now: 1000,
    toolDetail: "full",
    renderTools: (calls, detail, opts) => {
      batches.push({ names: calls.map((entry) => entry.name), last: opts?.last, detail })
      return [{ kind: "text", text: calls.map((entry) => entry.call.text).join("|") }]
    },
  })
  expect(batches).toEqual([
    { names: ["read"], last: false, detail: "full" },
    { names: ["read"], last: true, detail: "full" },
    { names: ["agent"], last: false, detail: "full" },
    { names: ["read"], last: true, detail: "full" },
  ])
  expect(rows.some((line) => line.kind === "text" && line.text.includes("live.ts  running"))).toBe(true)
  const child = rows.findIndex(
    (line) => line.kind === "segments" && line.parts.some((part) => part.text.includes("Nested check")),
  )
  expect(child).toBeGreaterThan(rows.findIndex((line) => line.kind === "text" && line.text === "started"))
  expect(child).toBeLessThan(rows.findIndex((line) => line.kind === "text" && line.text === "third"))
  const fallback = s.definition.render!(s.data, { width: 100, now: 1000 })
  expect(fallback.some((line) => line.kind === "text" && line.text === "  ├ read a.ts  ✓ first")).toBe(true)
})
