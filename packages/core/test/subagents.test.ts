import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type AnyEvent, type Budget, type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree, forkHistory, SpawnError } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

/** Every model call goes through `reply`, which sees the request (and so the session's role). */
async function setup(
  reply: (req: ModelRequest) => MockReply,
  opts: { maxConcurrent?: number; maxDepth?: number; budget?: Budget; store?: boolean } = {},
) {
  const mock = createMockDialect()
  for (let i = 0; i < 200; i++) mock.push(reply)
  const ai = createAi({
    dialects: [mock],
    providers: [
      { id: "mock", dialect: "mock", baseUrl: "" },
      { id: "cheap", dialect: "mock", baseUrl: "" },
    ],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const tree = new AgentTree({
    ai,
    sections: () => [{ name: "identity", text: "child identity" }],
    ...opts,
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-subagents-"))
  const session = opts.store ? SessionStore.create({ cwd: dir, dir }) : undefined
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const root = new Agent({
    ai,
    model: ai.model("mock/big"),
    cwd: dir,
    systemPrompt: "commander",
    bus,
    tree,
    interceptors,
    tools,
    ...(session ? { session } : {}),
  })
  return { ai, mock, bus, events, tree, root, dir, session, interceptors, tools }
}

/** The role text a request's system prompt ends with, e.g. "ROLE a". */
const roleOf = (req: ModelRequest) => /ROLE (\w+)/.exec(req.systemPrompt)?.[1] ?? "root"

test("a child runs as its own session and its events bubble with parentSessionId", async () => {
  const { root, tree, bus, events } = await setup((req) =>
    roleOf(req) === "a" ? { text: "found it", usage: { input: 10, output: 5 } } : { text: "ok" },
  )
  const child = tree.spawn(root, { role: "explorer", prompt: "find x", systemPrompt: "ROLE a" })
  const r = await child.result()
  await bus.flush()
  expect(r).toMatchObject({ sessionId: child.id, status: "done", text: "found it", steps: 1 })
  expect(r.usage).toMatchObject({ input: 10, output: 5 })
  expect(child.depth).toBe(1)
  expect(child.parentSessionId).toBe(root.sessionId)

  const start = events.find((e) => e.type === "subagent.start")!
  expect(start.sessionId).toBe(root.sessionId)
  expect(start.data).toMatchObject({
    childSessionId: child.id,
    role: "explorer",
    prompt: "find x",
    queued: false,
  })
  const own = events.filter((e) => e.sessionId === child.id)
  expect(own.map((e) => e.type)).toContain("turn.end")
  expect(own.every((e) => e.parentSessionId === root.sessionId)).toBe(true)
  expect(own[0]?.type).toBe("session.start")
  const end = events.find((e) => e.type === "subagent.end")!
  expect(end.sessionId).toBe(root.sessionId)
  expect(end.data).toMatchObject({ childSessionId: child.id, status: "done" })
  expect(events.filter((e) => e.type === "budget.update").at(-1)?.data).toEqual({ tokens: 15 })
})

test("child.events yields the child's events and ends with its subagent.end", async () => {
  const { root, tree } = await setup(() => ({ text: "hi" }))
  const child = tree.spawn(root, { prompt: "p" })
  const seen: AnyEvent[] = []
  for await (const e of child.events) seen.push(e)
  expect(seen[0]?.type).toBe("session.start")
  expect(seen.at(-1)?.type).toBe("subagent.end")
  expect(seen.filter((e) => e.type !== "subagent.end").every((e) => e.sessionId === child.id)).toBe(true)
})

test("children are stored as sessions under their parent's file", async () => {
  const { root, tree, session } = await setup(() => ({ text: "done" }), { store: true })
  await root.prompt("start")
  const child = tree.spawn(root, { role: "coder", prompt: "work" })
  await child.result()
  const reopened = SessionStore.open(session!.file)
  expect(reopened.entries.find((e) => e.type === "subagent")).toMatchObject({
    childSessionId: child.id,
    role: "coder",
  })
  const childFile = path.join(path.dirname(session!.file), "subagents", `${child.id}.jsonl`)
  const stored = SessionStore.open(childFile)
  expect(stored.header.parent).toBe(root.sessionId)
  expect(stored.restore().messages.map((m) => m.role)).toEqual(["user", "assistant"])
})

test("spawning deeper than maxDepth fails, and a tool can spawn through its session", async () => {
  const { root, tree, tools, bus, events } = await setup(
    (req) => {
      const role = roleOf(req)
      const last = req.messages.at(-1)
      if (last?.role === "toolResult")
        return { text: `${role} saw ${last.content[0]?.type === "text" ? last.content[0].text : ""}` }
      return role === "root" || role === "one" || role === "two"
        ? {
            toolCalls: [
              { name: "spawn", args: { role: role === "root" ? "one" : role === "one" ? "two" : "three" } },
            ],
          }
        : { text: "leaf" }
    },
    { maxDepth: 2 },
  )
  tools.register(
    defineTool<{ role: string }>({
      name: "spawn",
      description: "spawn",
      parameters: { type: "object", properties: { role: { type: "string" } } },
      execute: async (p, ctx) => {
        try {
          const r = await ctx.session!.spawn!({ prompt: "go", systemPrompt: `ROLE ${p.role}` }).result()
          return textResult(`[${r.text}]`)
        } catch (err) {
          return textResult(`refused: ${err instanceof SpawnError ? err.message : err}`, true)
        }
      },
    }),
    "t",
  )
  expect(tree.maxDepth).toBe(2)
  const r = await root.prompt("go")
  await bus.flush()
  expect(r.reason).toBe("done")
  const starts = events.filter((e) => e.type === "subagent.start")
  expect(starts.map((e) => e.type === "subagent.start" && e.data.depth)).toEqual([1, 2])
  const last = root.messages.at(-1)
  const text = last?.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : ""
  expect(text).toContain("refused: sub-agents can nest at most 2 levels deep")
})

test("at most maxConcurrent children of one parent run at once; the rest queue in order", async () => {
  const { root, tree, bus, events } = await setup(() => ({ text: "x", delayMs: 20 }), { maxConcurrent: 2 })
  let running = 0
  let peak = 0
  bus.subscribe(
    (e) => {
      if (e.type === "turn.start" && e.sessionId !== root.sessionId) peak = Math.max(peak, ++running)
      if (e.type === "turn.end" && e.sessionId !== root.sessionId) running--
    },
    { types: ["turn.start", "turn.end"] },
  )
  const kids = [1, 2, 3, 4].map((i) => tree.spawn(root, { prompt: `t${i}` }))
  const results = await Promise.all(kids.map((k) => k.result()))
  await bus.flush()
  expect(results.every((r) => r.status === "done")).toBe(true)
  expect(peak).toBe(2)
  const queued = events.flatMap((e) => (e.type === "subagent.start" ? [e.data.queued] : []))
  expect(queued).toEqual([false, false, true, true])
  // Queued children start in spawn order.
  const order = events.flatMap((e) =>
    e.type === "turn.start" && e.sessionId !== root.sessionId ? [e.sessionId] : [],
  )
  expect(order).toEqual(kids.map((k) => k.id))
})

test("aborting a queued child settles it without running it", async () => {
  const { root, tree } = await setup(() => ({ text: "x", delayMs: 30 }), { maxConcurrent: 1 })
  const first = tree.spawn(root, { prompt: "a" })
  const second = tree.spawn(root, { prompt: "b" })
  second.abort("not needed")
  expect(await second.result()).toMatchObject({ status: "aborted", error: "not needed", steps: 0 })
  expect((await first.result()).status).toBe("done")
})

test("going over the budget aborts running children and refuses new ones", async () => {
  const { root, tree, bus, events } = await setup(
    (req) =>
      roleOf(req) === "spender"
        ? { text: "spent", usage: { input: 80, output: 40 } }
        : { text: "slow", delayMs: 200 },
    { budget: { tokens: 100 } },
  )
  const slow = tree.spawn(root, { prompt: "wait", systemPrompt: "ROLE slow" })
  const spender = tree.spawn(root, { prompt: "spend", systemPrompt: "ROLE spender" })
  expect((await spender.result()).status).toBe("done")
  const r = await slow.result()
  expect(r.status).toBe("aborted")
  expect(r.error).toContain("budget ran out (120 tokens used, limit 100)")
  expect(() => tree.spawn(root, { prompt: "more" })).toThrow(SpawnError)
  await bus.flush()
  expect(events.find((e) => e.type === "budget.exceeded")?.data).toEqual({
    tokens: 120,
    limit: { tokens: 100 },
  })
})

test("cost budgets count reported costs", async () => {
  const { root, tree, bus, events } = await setup(() => ({ text: "x", usage: { input: 1, cost: 0.6 } }), {
    budget: { costUsd: 1 },
  })
  await tree.spawn(root, { prompt: "a" }).result()
  expect(events.some((e) => e.type === "budget.exceeded")).toBe(false)
  await tree.spawn(root, { prompt: "b" }).result()
  await bus.flush()
  expect(events.find((e) => e.type === "budget.exceeded")?.data).toMatchObject({ costUsd: 1.2 })
})

test("fork starts from the parent's history; fresh only from the prompt", async () => {
  const { root, tree, mock } = await setup(() => ({ text: "ok" }))
  await root.prompt("earlier question")
  await tree.spawn(root, { prompt: "forked task", context: "fork", systemPrompt: "ROLE f" }).result()
  const forked = mock.requests.at(-1)!
  expect(forked.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  expect(forked.systemPrompt).toContain("commander")
  expect(forked.systemPrompt).toContain("ROLE f")
  await tree.spawn(root, { prompt: "fresh task" }).result()
  const fresh = mock.requests.at(-1)!
  expect(fresh.messages.map((m) => m.role)).toEqual(["user"])
  expect(fresh.systemPrompt).toBe("child identity")
})

test("forkHistory drops tool calls that have no result yet", () => {
  const history = forkHistory([
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "agent", args: {} }],
      model: { provider: "m", model: "m" },
    },
  ])
  expect(history[1]).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "(Delegating to sub-agents.)" }],
  })
})

test("a child sees only the tools it was given, and a different model", async () => {
  const { root, tree, tools, mock } = await setup(() => ({ text: "ok" }))
  for (const name of ["read", "write", "bash"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        execute: async () => textResult(""),
      }),
      "t",
    )
  }
  const child = tree.spawn(root, { prompt: "p", tools: ["read"], model: "cheap/small" })
  expect(child.model).toEqual({ provider: "cheap", model: "small" })
  await child.result()
  expect(mock.requests.at(-1)!.tools?.map((t) => t.name)).toEqual(["read"])
  expect(mock.requests.at(-1)!.model.id).toBe("small")
  expect(() => tree.spawn(root, { prompt: "p", model: "nope/x" })).toThrow(SpawnError)
  await tree.spawn(root, { prompt: "p", excludeTools: ["bash"] }).result()
  expect(mock.requests.at(-1)!.tools?.map((t) => t.name)).toEqual(["read", "write"])
  await tree.spawn(root, { prompt: "p", tools: ["read", "bash"], excludeTools: ["bash"] }).result()
  expect(mock.requests.at(-1)!.tools?.map((t) => t.name)).toEqual(["read"])
})

test("a child's approval request goes to the parent's model (D14)", async () => {
  const { root, tree, interceptors, tools, events, bus } = await setup((req) => {
    const last = req.messages.at(-1)
    const text = last?.content[0]?.type === "text" ? last.content[0].text : ""
    if (text.includes("needs your approval")) {
      return { text: text.includes('"danger"') ? "DENY\nToo risky." : "APPROVE\nFine." }
    }
    if (last?.role === "toolResult") return { text: "finished" }
    return { toolCalls: [{ name: roleOf(req) === "d" ? "danger" : "safe", args: {} }] }
  })
  const ran: string[] = []
  for (const name of ["safe", "danger"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        execute: async () => {
          ran.push(name)
          return textResult("ran")
        },
      }),
      "t",
    )
  }
  interceptors.add("tool.call.before", () => ({ action: "ask", reason: "policy" }))
  await tree.spawn(root, { prompt: "p", systemPrompt: "ROLE s" }).result()
  const denied = tree.spawn(root, { prompt: "p", systemPrompt: "ROLE d" })
  await denied.result()
  await bus.flush()
  expect(ran).toEqual(["safe"])
  const end = events.find(
    (e) => e.type === "tool.execute.end" && e.sessionId === denied.id && e.data.name === "danger",
  )
  expect(end?.type === "tool.execute.end" && end.data.rejected).toBe("blocked")
  expect(JSON.stringify(end?.data)).toContain("the parent agent denied it: Too risky.")
  expect(
    events.some(
      (e) => e.type === "status.changed" && e.sessionId === denied.id && e.data.status === "blocked",
    ),
  ).toBe(true)
})

test("without an approver, a call an interceptor asks about is denied", async () => {
  const { root, interceptors, tools } = await setup((req) =>
    req.messages.at(-1)?.role === "toolResult" ? { text: "done" } : { toolCalls: [{ name: "t", args: {} }] },
  )
  let ran = false
  tools.register(
    defineTool({
      name: "t",
      description: "t",
      parameters: { type: "object" },
      execute: async () => {
        ran = true
        return textResult("")
      },
    }),
    "x",
  )
  interceptors.add("tool.call.before", () => ({ action: "ask", reason: "check" }))
  await root.prompt("go")
  expect(ran).toBe(false)
  const result = root.messages.find((m) => m.role === "toolResult")
  expect(JSON.stringify(result)).toContain("not approved")
})

test("tree.children lists live children", async () => {
  const { root, tree } = await setup(() => ({ text: "x", delayMs: 20 }))
  const kids: ChildSession[] = [tree.spawn(root, { prompt: "a" }), tree.spawn(root, { prompt: "b" })]
  expect(tree.children.map((c) => c.id)).toEqual(kids.map((k) => k.id))
  await Promise.all(kids.map((k) => k.result()))
  expect(tree.children).toEqual([])
})
