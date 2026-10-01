import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import {
  type AnyEvent,
  type AskQuestion,
  type AskRequest,
  type Budget,
  type ChildSession,
  defineTool,
  textResult,
} from "@amira/api"
import { Agent, type Asker } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree, forkHistory, parseParentAnswers, SpawnError } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

/** Every model call goes through `reply`, which sees the request (and so the session's role). */
async function setup(
  reply: (req: ModelRequest) => MockReply,
  opts: { maxConcurrent?: number; maxDepth?: number; budget?: Budget; store?: boolean; ask?: Asker } = {},
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
    ...(opts.ask ? { ask: opts.ask } : {}),
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

test("children of a non-interactive root are told so too, fresh or forked", async () => {
  const { root, tree, mock } = await setup(() => ({ text: "done" }))
  await tree.spawn(root, { prompt: "p", systemPrompt: "ROLE a" }).result()
  expect(mock.requests.at(-1)!.systemPrompt).not.toContain("Run mode: non-interactive")
  root.setNonInteractive()
  for (const context of ["fresh", "fork"] as const) {
    await tree.spawn(root, { prompt: "p", systemPrompt: "ROLE a", context }).result()
    expect(mock.requests.at(-1)!.systemPrompt).toContain("Run mode: non-interactive")
  }
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

test("at most maxConcurrent children run at once; the rest queue in order", async () => {
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

test("the limit holds across the tree; a parent waiting for its children does not count", async () => {
  const { root, tree, tools, bus } = await setup(
    (req) => {
      const role = roleOf(req)
      if (req.messages.at(-1)?.role === "toolResult") return { text: `${role} done` }
      return role === "mid" ? { toolCalls: [{ name: "fan", args: {} }] } : { text: "leaf", delayMs: 30 }
    },
    { maxConcurrent: 2 },
  )
  tools.register(
    defineTool({
      name: "fan",
      description: "fan",
      parameters: { type: "object" },
      execute: async (_p, ctx) => {
        const kids = [1, 2].map(() => ctx.session!.spawn!({ prompt: "leaf", systemPrompt: "ROLE leaf" }))
        await Promise.all(kids.map((k) => k.result()))
        return textResult("fanned")
      },
    }),
    "t",
  )
  let streaming = 0
  let peak = 0
  bus.subscribe(
    (e) => {
      if (e.sessionId === root.sessionId) return
      if (e.type === "message.start") peak = Math.max(peak, ++streaming)
      if (e.type === "message.end") streaming--
    },
    { types: ["message.start", "message.end"] },
  )
  const mids = [1, 2].map(() => tree.spawn(root, { prompt: "fan out", systemPrompt: "ROLE mid" }))
  const results = await Promise.all(mids.map((m) => m.result()))
  await bus.flush()
  expect(results.map((r) => r.text)).toEqual(["mid done", "mid done"])
  // Two parents with two children each: never more than two sessions talking to the model.
  expect(peak).toBe(2)
  expect(tree.children).toEqual([])
})

test("a child's events include its own children's, and a finished child has none to give", async () => {
  const { root, tree, tools } = await setup((req) =>
    req.messages.at(-1)?.role === "toolResult"
      ? { text: "done" }
      : roleOf(req) === "mid"
        ? { toolCalls: [{ name: "sub", args: {} }] }
        : { text: "leaf" },
  )
  let grandchild = ""
  tools.register(
    defineTool({
      name: "sub",
      description: "sub",
      parameters: { type: "object" },
      execute: async (_p, ctx) => {
        const kid = ctx.session!.spawn!({ prompt: "leaf", systemPrompt: "ROLE leaf" })
        grandchild = kid.id
        await kid.result()
        return textResult("ok")
      },
    }),
    "t",
  )
  const child = tree.spawn(root, { prompt: "go", systemPrompt: "ROLE mid" })
  const seen: AnyEvent[] = []
  for await (const e of child.events) seen.push(e)
  expect(seen.some((e) => e.sessionId === grandchild && e.type === "turn.end")).toBe(true)
  expect(seen.some((e) => e.type === "subagent.end" && e.data.childSessionId === grandchild)).toBe(true)
  expect(seen.at(-1)?.type === "subagent.end" && seen.at(-1)?.sessionId).toBe(root.sessionId)
  const after: AnyEvent[] = []
  for await (const e of child.events) after.push(e)
  expect(after).toEqual([])
})

test("a sub-agent a tool spawns carries that call's id and its title, start to end", async () => {
  const { root, tree, tools, events, bus } = await setup((req) =>
    roleOf(req) === "root"
      ? req.messages.at(-1)?.role === "toolResult"
        ? { text: "done" }
        : {
            toolCalls: [
              { name: "spawner", args: { n: 1 } },
              { name: "spawner", args: { n: 2 } },
            ],
          }
      : { text: "leaf" },
  )
  const kids = new Map<string, string>()
  tools.register(
    defineTool<{ n: number }>({
      name: "spawner",
      description: "",
      parameters: { type: "object" },
      concurrency: "parallel",
      execute: async (p, ctx) => {
        const kid = ctx.session!.spawn!({
          title: `Task ${p.n}`,
          prompt: `same task`,
          systemPrompt: "ROLE leaf",
        })
        kids.set(kid.id, ctx.toolCallId)
        await kid.result()
        return textResult("ok")
      },
    }),
    "t",
  )
  await root.prompt("go")
  await bus.flush()
  expect(kids.size).toBe(2)
  for (const [id, call] of kids) {
    const start = events.find((e) => e.type === "subagent.start" && e.data.childSessionId === id)
    const end = events.find((e) => e.type === "subagent.end" && e.data.childSessionId === id)
    expect(start?.type === "subagent.start" && start.data.toolCallId).toBe(call)
    expect(end?.type === "subagent.end" && end.data.toolCallId).toBe(call)
    expect(tree.subagent(id)?.info).toMatchObject({
      toolCallId: call,
      title: expect.stringMatching(/^Task \d$/),
    })
  }
  // Spawned outside a tool call: no call, and a title from its task.
  const loose = tree.spawn(root, { prompt: "look  around the repo", systemPrompt: "ROLE leaf" })
  await loose.result()
  await bus.flush()
  const start = events.find((e) => e.type === "subagent.start" && e.data.childSessionId === loose.id)
  expect(start?.type === "subagent.start" && start.data.toolCallId).toBeUndefined()
  expect(tree.subagent(loose.id)?.info.title).toBe("look around the repo")
})

test("aborting a queued child settles it without running it", async () => {
  const { root, tree } = await setup(() => ({ text: "x", delayMs: 30 }), { maxConcurrent: 1 })
  const first = tree.spawn(root, { prompt: "a" })
  const second = tree.spawn(root, { prompt: "b" })
  second.abort("not needed")
  expect(await second.result()).toMatchObject({ status: "aborted", error: "not needed", steps: 0 })
  expect((await first.result()).status).toBe("done")
})

test("tree.stop aborts one live child by id and refuses unknown or ended ones", async () => {
  const { root, tree } = await setup(() => ({ text: "x", delayMs: 50 }))
  const a = tree.spawn(root, { prompt: "a" })
  const b = tree.spawn(root, { prompt: "b" })
  await Bun.sleep(5)
  expect(tree.stop(a.id, "stopped by the user")).toBe(true)
  expect(tree.stop(a.id, "again")).toBe(false)
  expect(tree.stop("s_nope", "x")).toBe(false)
  expect(await a.result()).toMatchObject({ status: "aborted", error: "stopped by the user" })
  expect((await b.result()).status).toBe("done")
  expect(tree.stop(b.id, "late")).toBe(false)
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

/** A tool that puts the questions in its args to whoever answers and returns the outcome. */
const askTool = defineTool<{ questions: AskQuestion[] }>({
  name: "ask",
  description: "ask",
  parameters: { type: "object" },
  execute: async ({ questions }, ctx) =>
    textResult(JSON.stringify(await ctx.session!.askUser!(questions, ctx.signal))),
})

const QUESTIONS: AskQuestion[] = [
  {
    question: "Which approach?",
    header: "Approach",
    options: [{ label: "Fast (Recommended)" }, { label: "Safe" }],
  },
  {
    question: "Extras?",
    options: [{ label: "tests" }, { label: "docs" }, { label: "lint" }],
    multiSelect: true,
  },
]

/** The commander replies `commander`; the child asks QUESTIONS once and ends with the outcome. */
async function askChild(commander: string, ask?: Asker) {
  const prompts: string[] = []
  const s = await setup(
    (req) => {
      const last = req.messages.at(-1)
      const text = last?.content[0]?.type === "text" ? last.content[0].text : ""
      if (text.includes("asks you these questions")) {
        prompts.push(text)
        return { text: commander }
      }
      if (last?.role === "toolResult") return { text: "finished" }
      return { toolCalls: [{ name: "ask", args: { questions: QUESTIONS } }] }
    },
    ask ? { ask } : {},
  )
  s.tools.register(askTool, "t")
  const child = s.tree.spawn(s.root, { prompt: "p" })
  await child.result()
  await s.bus.flush()
  const end = s.events.find((e) => e.type === "tool.execute.end" && e.sessionId === child.id)
  const content = end?.type === "tool.execute.end" ? end.data.result.content[0] : undefined
  const outcome = JSON.parse(content?.type === "text" ? content.text : "null")
  return { ...s, prompts, outcome, child }
}

test("a child's questions go to its commander's model, which answers them", async () => {
  const { outcome, prompts, events, child } = await askChild("1: Fast\n2: tests | lint | also docs please")
  expect(prompts[0]).toContain("1. [Approach] Which approach? (choose one)")
  expect(prompts[0]).toContain("   - Fast (Recommended)")
  expect(prompts[0]).toContain("2. Extras? (choose any number)")
  expect(outcome).toEqual({
    answers: [
      { selected: ["Fast (Recommended)"] },
      { selected: ["tests", "lint"], other: "also docs please" },
    ],
    by: "the commander",
  })
  // The child shows as blocked while it waits, like for an approval.
  expect(
    events.some(
      (e) =>
        e.type === "status.changed" &&
        e.sessionId === child.id &&
        e.data.status === "blocked" &&
        e.data.reason === "question for the commander",
    ),
  ).toBe(true)
})

test("a commander may decline, or pass a child's questions on to whoever answers for it", async () => {
  expect((await askChild("DECLINE\nnot mine to say")).outcome).toEqual({
    declined: true,
    by: "the commander",
  })
  // Without anyone above it, passing them on reaches nobody.
  expect((await askChild("ASK_USER")).outcome).toEqual({ unavailable: "nobody can answer questions here" })
  const asked: AskRequest[] = []
  const user: Asker = async (req) => {
    asked.push(req)
    return { answers: [{ selected: ["Safe"] }, { selected: [] }] }
  }
  const { outcome, child } = await askChild("ASK_USER", user)
  expect(outcome).toEqual({ answers: [{ selected: ["Safe"] }, { selected: [] }] })
  expect(asked).toEqual([{ sessionId: child.id, toolCallId: expect.any(String), questions: QUESTIONS }])
})

test("ASK_USER alone on a line after some prose still passes the questions on", async () => {
  const user: Asker = async () => ({ answers: [{ selected: ["Safe"] }, { selected: [] }] })
  const { outcome } = await askChild("That is for the user to decide.\n\n**ASK_USER**", user)
  expect(outcome).toEqual({ answers: [{ selected: ["Safe"] }, { selected: [] }] })
})

test("a child aborted while its question waits behind another leaves the line at once", async () => {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const user: Asker = async () => {
    await held
    return { answers: [{ selected: ["Safe"] }, { selected: [] }] }
  }
  const s = await setup(
    (req) => {
      const last = req.messages.at(-1)
      const text = last?.content[0]?.type === "text" ? last.content[0].text : ""
      if (text.includes("asks you these questions")) return { text: "ASK_USER" }
      if (last?.role === "toolResult") return { text: "finished" }
      return { toolCalls: [{ name: "ask", args: { questions: QUESTIONS } }] }
    },
    { ask: user },
  )
  s.tools.register(askTool, "t")
  const first = s.tree.spawn(s.root, { prompt: "p" })
  const second = s.tree.spawn(s.root, { prompt: "p" })
  // Both have asked: the first waits for the user, the second for its place.
  await waitUntil(() =>
    [first.id, second.id].every((id) =>
      s.events.some((e) => e.type === "status.changed" && e.sessionId === id && e.data.status === "blocked"),
    ),
  )
  const started = performance.now()
  second.abort()
  expect((await second.result()).status).toBe("aborted")
  expect(performance.now() - started).toBeLessThan(1000)
  release()
  expect((await first.result()).status).toBe("done")
  await s.bus.flush()
  // The aborted one is not set working again when the line moves on.
  const statuses = s.events.flatMap((e) =>
    e.type === "status.changed" && e.sessionId === second.id ? [e.data.status] : [],
  )
  expect(statuses.at(-1)).not.toBe("working")
})

test("a question asked after a waiting one was aborted still waits for the one being answered", async () => {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let open = 0
  let most = 0
  const user: Asker = async () => {
    open++
    most = Math.max(most, open)
    await held
    open--
    return { answers: [{ selected: ["Safe"] }, { selected: [] }] }
  }
  const s = await setup(
    (req) => {
      const last = req.messages.at(-1)
      const text = last?.content[0]?.type === "text" ? last.content[0].text : ""
      if (text.includes("asks you these questions")) return { text: "ASK_USER" }
      if (last?.role === "toolResult") return { text: "finished" }
      return { toolCalls: [{ name: "ask", args: { questions: QUESTIONS } }] }
    },
    { ask: user },
  )
  s.tools.register(askTool, "t")
  const blocked = (id: string) =>
    s.events.some((e) => e.type === "status.changed" && e.sessionId === id && e.data.status === "blocked")
  const first = s.tree.spawn(s.root, { prompt: "p" })
  await waitUntil(() => open === 1)
  const second = s.tree.spawn(s.root, { prompt: "p" })
  await waitUntil(() => blocked(second.id))
  second.abort()
  expect((await second.result()).status).toBe("aborted")
  const third = s.tree.spawn(s.root, { prompt: "p" })
  await waitUntil(() => blocked(third.id))
  await Bun.sleep(50)
  // The first is still with the user; the third waits for its place.
  expect(most).toBe(1)
  release()
  expect((await first.result()).status).toBe("done")
  expect((await third.result()).status).toBe("done")
  expect(most).toBe(1)
})

async function waitUntil(check: () => boolean, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

test("a commander's answers are read loosely, and a question without one fails the lot", () => {
  const one = [QUESTIONS[0]!]
  expect(parseParentAnswers(one, "**1.** `safe`")).toEqual([{ selected: ["Safe"] }])
  expect(parseParentAnswers(one, "Go with the fast one, but carefully")).toEqual([
    { selected: [], other: "Go with the fast one, but carefully" },
  ])
  expect(parseParentAnswers(QUESTIONS, "1: Safe")).toBeUndefined()
})

test("approval questions to one parent are asked one at a time", async () => {
  const asked: number[] = []
  const { root, tree, interceptors, tools } = await setup((req) => {
    const last = req.messages.at(-1)
    const text = last?.content[0]?.type === "text" ? last.content[0].text : ""
    if (text.includes("needs your approval")) {
      asked.push(performance.now())
      return { text: "APPROVE\nok", delayMs: 40 }
    }
    if (last?.role === "toolResult") return { text: "finished" }
    return { toolCalls: [1, 2, 3].map((i) => ({ name: "p", args: { i } })) }
  })
  tools.register(
    defineTool({
      name: "p",
      description: "p",
      parameters: { type: "object" },
      concurrency: "parallel",
      execute: async () => textResult("ran"),
    }),
    "t",
  )
  interceptors.add("tool.call.before", () => ({ action: "ask", reason: "policy" }))
  expect((await tree.spawn(root, { prompt: "p" }).result()).status).toBe("done")
  expect(asked.length).toBe(3)
  // Each question starts only after the previous answer (a reply takes at least 40 ms).
  for (let i = 1; i < asked.length; i++) expect(asked[i]! - asked[i - 1]!).toBeGreaterThanOrEqual(35)
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
