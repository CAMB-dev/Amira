import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { listSubagents } from "../src/subagent-list.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

async function setup(reply: (req: ModelRequest) => MockReply, store = true) {
  const mock = createMockDialect()
  for (let i = 0; i < 50; i++) mock.push(reply)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const tree = new AgentTree({ ai, sections: () => [] })
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-subagent-list-"))
  const tools = new ToolRegistry()
  const bus = new EventBus()
  const make = (session?: SessionStore, t: AgentTree = tree) =>
    new Agent({
      ai,
      model: ai.model("mock/m"),
      cwd: dir,
      systemPrompt: "root",
      bus,
      tree: t,
      tools,
      ...(session ? { session } : {}),
    })
  const session = store ? SessionStore.create({ cwd: dir, dir }) : undefined
  return { ai, tree, tools, dir, root: make(session), session, make }
}

const roleOf = (req: ModelRequest) => /ROLE (\w+)/.exec(req.systemPrompt)?.[1] ?? "root"

test("running, queued and finished sub-agents are listed with their state and conversation", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { root, tree, tools } = await setup((req) =>
    roleOf(req) === "root"
      ? { text: "ok" }
      : roleOf(req) === "a"
        ? { text: "found it", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }
        : req.messages.at(-1)?.role === "toolResult"
          ? { text: "slow done" }
          : { toolCalls: [{ name: "wait", args: {} }] },
  )
  tools.register(
    defineTool({
      name: "wait",
      description: "",
      parameters: {},
      execute: () => gate.then(() => textResult("ok")),
    }),
    "t",
  )
  await root.prompt("hi")
  const a = tree.spawn(root, { role: "explorer", prompt: "find x", systemPrompt: "ROLE a" })
  await a.result()
  const b = tree.spawn(root, { prompt: "slow task", systemPrompt: "ROLE b" })
  const deadline = Date.now() + 2000
  while (
    !listSubagents(root, tree)[1]
      ?.messages()
      .some((m) => m.role === "assistant")
  ) {
    if (Date.now() > deadline) throw new Error("child b never replied")
    await Bun.sleep(5)
  }
  const [first, second] = listSubagents(root, tree)
  expect(first!.info).toMatchObject({
    id: a.id,
    parentSessionId: root.sessionId,
    depth: 1,
    role: "explorer",
    task: "find x",
    status: "done",
    usage: { input: 100, output: 20, cost: 0.01 },
  })
  expect(first!.info.durationMs).toBeGreaterThanOrEqual(0)
  expect(first!.messages().map((m) => m.role)).toEqual(["user", "assistant"])
  expect(second!.info).toMatchObject({ id: b.id, role: "agent", task: "slow task", status: "running" })
  expect(second!.info.startedAt).toBeGreaterThan(0)
  expect(second!.info.durationMs).toBeUndefined()
  // A snapshot: the running child's conversation goes on without it.
  const snapshot = second!.messages()
  expect(snapshot.map((m) => m.role)).toEqual(["user", "assistant"])
  release()
  await b.result()
  expect(snapshot).toHaveLength(2)
  expect(
    listSubagents(root, tree)[1]!
      .messages()
      .map((m) => m.role),
  ).toEqual(["user", "assistant", "toolResult", "assistant"])
})

test("nested sub-agents follow their parent, one level deeper", async () => {
  const { root, tree, tools } = await setup((req) =>
    req.messages.at(-1)?.role === "toolResult"
      ? { text: "mid done" }
      : roleOf(req) === "mid"
        ? { toolCalls: [{ name: "sub", args: {} }] }
        : { text: "leaf" },
  )
  tools.register(
    defineTool({
      name: "sub",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        await ctx.session!.spawn!({ role: "leaf", prompt: "leaf task", systemPrompt: "ROLE leaf" }).result()
        return textResult("ok")
      },
    }),
    "t",
  )
  const mid = tree.spawn(root, { role: "mid", prompt: "mid task", systemPrompt: "ROLE mid" })
  await mid.result()
  const other = tree.spawn(root, { role: "other", prompt: "later", systemPrompt: "ROLE x" })
  await other.result()
  const list = listSubagents(root, tree).map((e) => [e.info.role, e.info.depth, e.info.parentSessionId])
  expect(list).toEqual([
    ["mid", 1, root.sessionId],
    ["leaf", 2, mid.id],
    ["other", 1, root.sessionId],
  ])
})

test("a resumed session lists the sub-agents of its earlier runs from their files", async () => {
  const { root, tree, session, make, tools, ai } = await setup((req) =>
    req.messages.at(-1)?.role === "toolResult"
      ? { text: "mid done", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }
      : roleOf(req) === "mid"
        ? {
            toolCalls: [{ name: "sub", args: {} }],
            usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
          }
        : { text: "leaf answer" },
  )
  tools.register(
    defineTool({
      name: "sub",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        await ctx.session!.spawn!({ role: "leaf", prompt: "leaf task", systemPrompt: "ROLE leaf" }).result()
        return textResult("ok")
      },
    }),
    "t",
  )
  await root.prompt("start")
  const mid = tree.spawn(root, { role: "mid", prompt: "mid task", systemPrompt: "ROLE mid" })
  await mid.result()
  // A later process: a new tree that knows nothing, and the session reopened from its file.
  const resumed = make(SessionStore.open(session!.file), new AgentTree({ ai, sections: () => [] }))
  const list = listSubagents(resumed, resumed.tree)
  expect(list.map((e) => e.info)).toEqual([
    expect.objectContaining({
      id: mid.id,
      depth: 1,
      role: "mid",
      task: "mid task",
      status: "done",
      usage: { input: 15, output: 6, cacheRead: 0, cacheWrite: 0 },
    }),
    expect.objectContaining({
      depth: 2,
      role: "leaf",
      task: "leaf task",
      status: "done",
      parentSessionId: mid.id,
    }),
  ])
  expect(list[0]!.info.startedAt).toBeGreaterThan(0)
  expect(list[1]!.messages().at(-1)).toMatchObject({ role: "assistant", content: [{ text: "leaf answer" }] })
})

test("without a session file, only this process's sub-agents are known", async () => {
  const { root, tree } = await setup(() => ({ text: "x" }), false)
  expect(listSubagents(root, tree)).toEqual([])
  await tree.spawn(root, { prompt: "p" }).result()
  expect(listSubagents(root, tree).map((e) => e.info.task)).toEqual(["p"])
  expect(listSubagents(root)).toEqual([])
})
