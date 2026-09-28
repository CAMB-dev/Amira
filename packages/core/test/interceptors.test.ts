import { expect, test } from "bun:test"
import { defineTool } from "@amira/api"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolConflictError, ToolRegistry } from "../src/tool-registry.ts"

const ctx = { sessionId: "s", signal: new AbortController().signal }
const call = { toolCallId: "c", name: "bash", args: { command: "ls" } }

test("runs by priority, chains modify and stops at block", async () => {
  const r = new InterceptorRegistry()
  const order: string[] = []
  r.add(
    "tool.call.before",
    (v) => {
      order.push("late")
      return { action: "modify", value: { ...v, args: { command: `${v.args.command} -la` } } }
    },
    { priority: 10 },
  )
  r.add("tool.call.before", (v) => {
    order.push("early")
    return { action: "modify", value: { ...v, args: { command: `echo; ${v.args.command}` } } }
  })
  const out = await r.run("tool.call.before", call, ctx)
  expect(order).toEqual(["early", "late"])
  expect(out).toEqual({ blocked: false, value: { ...call, args: { command: "echo; ls -la" } } })

  r.add("tool.call.before", () => ({ action: "block", reason: "nope" }), { priority: 5 })
  const blocked = await r.run("tool.call.before", call, ctx)
  expect(blocked.blocked).toBe(true)
  expect(order).toEqual(["early", "late", "early"])
})

test("failure policy: tool.call.before blocks, context.build passes", async () => {
  const errors: string[] = []
  const r = new InterceptorRegistry({
    defaultTimeoutMs: 20,
    onError: (p, s, e) => errors.push(`${p}:${s}:${e}`),
  })
  r.add("tool.call.before", () => new Promise(() => {}), {}, "slow-ext")
  r.add(
    "context.build",
    () => {
      throw new Error("bad")
    },
    {},
    "bad-ext",
  )

  const t = await r.run("tool.call.before", call, ctx)
  expect(t.blocked).toBe(true)
  if (t.blocked) expect(t.reason).toContain("slow-ext")

  const c = await r.run("context.build", { systemPrompt: "s", messages: [] }, ctx)
  expect(c).toEqual({ blocked: false, value: { systemPrompt: "s", messages: [] } })
  expect(errors).toEqual(["tool.call.before:slow-ext:timed out after 20 ms", "context.build:bad-ext:bad"])
})

test("tool registry requires override: true to replace, and restores on unregister", () => {
  const reg = new ToolRegistry()
  const base = defineTool({
    name: "read",
    description: "a",
    parameters: {},
    execute: async () => ({ content: [] }),
  })
  reg.register(base, "builtin")
  expect(() => reg.register({ ...base, description: "b" }, "ext")).toThrow(ToolConflictError)
  const off = reg.register({ ...base, description: "c", override: true }, "ext")
  expect(reg.get("read")?.description).toBe("c")
  off()
  expect(reg.get("read")?.description).toBe("a")
  reg.register(
    defineTool({
      name: "hidden",
      description: "",
      parameters: {},
      exposure: "inactive",
      execute: async () => ({ content: [] }),
    }),
    "x",
  )
  expect(reg.specs().map((s) => s.name)).toEqual(["read"])
})

test("disabled tools are hidden from the model and cannot be called", () => {
  const reg = new ToolRegistry()
  const mk = (name: string) =>
    defineTool({ name, description: "", parameters: {}, execute: async () => ({ content: [] }) })
  reg.register(mk("bash"), "b")
  reg.register(mk("powershell"), "b")
  reg.setDisabled(["powershell"])
  expect(reg.specs().map((s) => s.name)).toEqual(["bash"])
  expect(reg.get("powershell")).toBeUndefined()
  expect(reg.all().map((r) => r.tool.name)).toEqual(["bash"])
  expect(reg.has("powershell")).toBe(true)
  expect(reg.list().map((r) => [r.tool.name, r.source, r.disabled])).toEqual([
    ["bash", "b", false],
    ["powershell", "b", true],
  ])
  reg.setDisabled([])
  expect(reg.get("powershell")).toBeDefined()
})
