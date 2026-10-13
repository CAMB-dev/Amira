import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest, userMessage } from "@amira/ai"
import { type AnyEvent, type Budget, type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree, SpawnError } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function setup(
  reply: (request: ModelRequest) => MockReply = () => ({ text: "done" }),
  opts: { maxConcurrent?: number; maxDepth?: number; budget?: Budget } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-private-child-"))
  const mock = createMockDialect()
  for (let i = 0; i < 100; i++) mock.push(reply)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const sections = [{ name: "identity", text: "shared identity" }]
  const tree = new AgentTree({ ai, sections: () => sections, ...opts })
  const session = SessionStore.create({ cwd: dir, dir })
  const tools = new ToolRegistry()
  const root = new Agent({ ai, model: ai.model("mock/m"), cwd: dir, bus, tree, session, tools, sections })
  cleanup.push(async () => {
    await root.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { root, tree, tools, mock, session, bus, events, dir }
}

async function until(done: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("child lifecycle did not reach the expected state")
    await Bun.sleep(2)
  }
}

function agentOf(child: ChildSession): Agent {
  if (!(child instanceof Child)) throw new Error("expected a tree-owned child")
  return child.agent
}

async function collect(child: ChildSession) {
  const events: AnyEvent[] = []
  for await (const event of child.events) events.push(event)
  return events
}

const lastText = (request: ModelRequest) =>
  request.messages
    .at(-1)
    ?.content.map((block) => (block.type === "text" ? block.text : ""))
    .join("") ?? ""

test("ephemeral children have no store, parent entry, listing or public transcript, but stream privately", async () => {
  const { root, tree, session, bus, events, dir } = await setup()
  await root.prompt("parent history")
  const before = [...root.messages]
  const filesBefore = await readdir(dir)
  const child = tree.spawn(root, { prompt: "private task", ephemeral: true, maxTurns: 1 })
  const streamed = collect(child)
  expect(agentOf(child).session).toBeUndefined()
  expect(agentOf(child).bus).not.toBe(bus)
  expect(tree.children).toEqual([])
  expect(tree.childrenOf(root.sessionId)).toEqual([])
  expect(tree.subagent(child.id)).toBeUndefined()
  expect(await child.result()).toMatchObject({ status: "done", text: "done", turns: 1 })
  const seen = await streamed
  await bus.flush()
  expect(seen.map((event) => event.type)).toContain("message.delta")
  expect(seen.at(-1)?.type).toBe("subagent.end")
  expect(events.some((event) => event.sessionId === child.id || event.type.startsWith("subagent."))).toBe(
    false,
  )
  expect(root.messages).toEqual(before)
  expect(session.entries.some((entry) => entry.type === "subagent")).toBe(false)
  expect(await readdir(dir)).toEqual(filesBefore)
  expect(tree.subagent(child.id)).toBeUndefined()
  expect(tree.childrenOf(root.sessionId)).toEqual([])
  expect(tree.children).toEqual([])
  expect(await collect(child)).toEqual([])
  expect(child.send("too late")).toBe(false)
})

test("ephemeral implies persistent: send and delivered notices automatically start follow-up turns", async () => {
  const { root, tree, mock } = await setup((request) => ({ text: lastText(request) }))
  const child = tree.spawn(root, { prompt: "first", ephemeral: true, persistent: false })
  expect(child.persistent).toBe(true)
  const streamed = collect(child)
  await until(() => child.state === "idle")
  expect(child.send("second")).toBe(true)
  await until(() => child.turns === 2 && child.state === "idle")
  const notice = child.expectNotice()
  notice.deliver(userMessage("third"))
  await until(() => child.turns === 3 && child.state === "idle")
  child.stop("finished privately")
  expect(await child.result()).toMatchObject({
    status: "done",
    text: "third",
    turns: 3,
    note: "finished privately",
  })
  expect(mock.requests.map(lastText)).toEqual(["first", "second", "third"])
  expect((await streamed).filter((event) => event.type === "turn.start")).toHaveLength(3)
})

test("private replies append side_usage with cost once, across turns, without persisting messages", async () => {
  const { root, tree, session, bus, events } = await setup(() => ({
    text: "private answer",
    usage: { input: 7, output: 3, cost: 0.25 },
  }))
  const child = tree.spawn(root, { prompt: "task", title: "private usage", ephemeral: true, maxTurns: 2 })
  await until(() => child.state === "idle")
  child.send("again")
  expect(await child.result()).toMatchObject({ usage: { input: 14, output: 6, cost: 0.5 } })
  expect(tree.usage).toMatchObject({ input: 14, output: 6, cost: 0.5 })
  await bus.flush()
  expect(events.findLast((event) => event.type === "budget.update")).toMatchObject({
    sessionId: root.sessionId,
    data: { costUsd: 0.5 },
  })
  // Like api.complete, side usage is buffered until the owner has something to save.
  expect(session.entries.some((entry) => entry.type === "message" || entry.type === "subagent")).toBe(false)
  session.appendMessage(userMessage("main history"))
  const entries = SessionStore.open(session.file).entries
  const usage = entries.filter((entry) => entry.type === "side_usage")
  expect(usage).toHaveLength(2)
  expect(usage[0]).toMatchObject({
    type: "side_usage",
    model: { provider: "mock", model: "m" },
    usage: { cost: 0.25 },
    label: "private usage",
  })
  expect(entries.some((entry) => entry.type === "subagent")).toBe(false)
  expect(SessionStore.open(session.file).restore().messages).toEqual([userMessage("main history")])
})

for (const consultation of ["approval", "ask"] as const) {
  for (const nested of [false, true]) {
    const prefix = nested ? "nested private" : "private"
    const name = `${prefix} ${consultation} consultations persist and count spend once`
    test(name, async () => {
      const { root, tree, tools, session, mock } = await setup((request) => {
        if (lastText(request) === "lead") return { text: "ready" }
        if (lastText(request).includes("needs your approval"))
          return { text: "APPROVE", usage: { input: 9, output: 1, cost: 0.5 } }
        if (lastText(request).includes("asks you this question"))
          return { text: "1: Safe", usage: { input: 9, output: 1, cost: 0.5 } }
        if (request.messages.at(-1)?.role === "toolResult")
          return { text: "done", usage: { input: 2, output: 1, cost: 0.125 } }
        return { toolCalls: [{ name: "consult", args: {} }], usage: { input: 3, cost: 0.125 } }
      })
      if (consultation === "approval")
        root.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "check" }))
      tools.register(
        defineTool({
          name: "consult",
          description: "consult",
          parameters: { type: "object" },
          execute: async (_args, context) => {
            if (consultation === "ask") {
              const answer = await context.session!.askUser!(
                [{ question: "Which?", options: [{ label: "Safe" }] }],
                context.signal,
              )
              return textResult(JSON.stringify(answer))
            }
            return textResult("approved")
          },
        }),
        "test",
      )
      const group = tree.createGroup(root, { name: "consulting" })
      const lead = nested ? group.spawn({ prompt: "lead", ephemeral: true }) : undefined
      if (lead) await until(() => lead.state === "idle")
      const requestingGroup = lead ? tree.createGroup(agentOf(lead), { name: "nested" }) : group
      const child = requestingGroup.spawn({
        prompt: "private",
        model: "mock/child",
        ephemeral: true,
        maxTurns: 1,
      })
      const result = await child.result()
      expect(result.status).toBe("done")
      expect(mock.requests).toHaveLength(nested ? 4 : 3)
      expect(result.usage).toMatchObject({ input: 14, output: 2, cost: 0.75 })
      expect(session.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(nested ? 4 : 3)
      expect(requestingGroup.info().usage).toMatchObject({ input: 14, output: 2, cost: 0.75 })
      expect(tree.usage).toMatchObject({ input: 14, output: 2, cost: 0.75 })
      expect(group.info().usage).toMatchObject({ input: 14, output: 2, cost: 0.75 })
      session.appendMessage(userMessage("save owner"))
      const entries = SessionStore.open(session.file).entries
      expect(entries.filter((entry) => entry.type === "side_usage")).toHaveLength(nested ? 4 : 3)
      expect(entries.find((entry) => entry.type === "side_usage" && entry.usage.cost === 0.5)).toMatchObject({
        model: { provider: "mock", model: "m" },
        label: "private",
      })
      expect(SessionStore.open(session.file).restore().messages).toEqual([userMessage("save owner")])
      lead?.stop()
      if (lead) await lead.result()
    })
  }
}

test("a private consultation can spend its requesting group's budget and abort the child", async () => {
  const { root, tree, tools, session } = await setup((request) => {
    if (lastText(request).includes("needs your approval"))
      return { text: "APPROVE", usage: { input: 9, cost: 0.5 } }
    if (request.messages.at(-1)?.role === "toolResult") return { text: "done" }
    return { toolCalls: [{ name: "consult", args: {} }], usage: { input: 3, cost: 0.125 } }
  })
  root.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "check" }))
  let executed = false
  tools.register(
    defineTool({
      name: "consult",
      description: "consult",
      parameters: { type: "object" },
      execute: async () => {
        executed = true
        return textResult("approved")
      },
    }),
    "test",
  )
  const group = tree.createGroup(root, { name: "consulting", budget: { costUsd: 0.4 } })
  const child = group.spawn({ prompt: "private", ephemeral: true, maxTurns: 1 })
  expect(await child.result()).toMatchObject({
    status: "aborted",
    error: expect.stringContaining("ran out of budget"),
    usage: { input: 12, cost: 0.625 },
  })
  expect(executed).toBe(false)
  expect(group.info()).toMatchObject({ state: "ended", exceeded: true, usage: { input: 12, cost: 0.625 } })
  expect(tree.usage).toMatchObject({ input: 12, cost: 0.625 })
  expect(session.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(2)
  expect(() => group.spawn({ prompt: "more", ephemeral: true })).toThrow("has ended")
})

test("private usage still spends the tree's token and cost budgets", async () => {
  for (const budget of [{ tokens: 5 }, { costUsd: 0.1 }]) {
    const { root, tree, session } = await setup(() => ({ text: "answer", usage: { input: 6, cost: 0.2 } }), {
      budget,
    })
    const child = tree.spawn(root, { prompt: "task", ephemeral: true })
    expect(await child.result()).toMatchObject({
      status: "aborted",
      error: expect.stringContaining("budget ran out"),
    })
    expect(tree.usage).toMatchObject({ input: 6, cost: 0.2 })
    expect(session.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(1)
    expect(() => tree.spawn(root, { prompt: "more", ephemeral: true })).toThrow(SpawnError)
  }
})

test("callableTools denies writes before interceptors or execution without removing declarations", async () => {
  const { root, tree, tools, mock } = await setup((request) =>
    request.messages.at(-1)?.role === "toolResult"
      ? { text: "done" }
      : {
          toolCalls: [
            { name: "write", args: {} },
            { name: "read", args: {} },
          ],
        },
  )
  const executed: string[] = []
  const intercepted: string[] = []
  root.interceptors.add("tool.call.before", (context) => {
    intercepted.push(context.name)
    return { action: "pass" }
  })
  for (const name of ["read", "write"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        execute: async () => {
          executed.push(name)
          return textResult(name)
        },
      }),
      "test",
    )
  }
  const child = tree.spawn(root, { prompt: "task", ephemeral: true, callableTools: ["read"], maxTurns: 1 })
  await child.result()
  expect(
    mock.requests.every((request) => request.tools.map((tool) => tool.name).join(",") === "read,write"),
  ).toBe(true)
  expect(executed).toEqual(["read"])
  expect(intercepted).toEqual(["read"])
  const denied = agentOf(child).messages.find(
    (message) => message.role === "toolResult" && message.toolName === "write",
  )
  expect(denied).toMatchObject({
    isError: true,
    rejected: "blocked",
    content: [{ type: "text", text: 'Tool "write" is not callable in this session.' }],
  })
})

test("mainOnly declarations stay listed in private forks, including deferred and extra tools, but cannot run", async () => {
  const names = ["main", "deferred_main", "extra_main"]
  const { root, tree, tools, mock } = await setup((request) =>
    lastText(request) === "private"
      ? { toolCalls: names.map((name) => ({ name, args: {} })) }
      : { text: "done" },
  )
  let executed = 0
  const make = (name: string, deferred = false) =>
    defineTool({
      name,
      description: name,
      parameters: { type: "object" },
      mainOnly: true,
      ...(deferred ? { exposure: "deferred" as const } : {}),
      execute: async () => {
        executed++
        return textResult("should not run")
      },
    })
  tools.register(make("main"), "test")
  tools.register(make("deferred_main", true), "test")
  root.loadTools(["deferred_main"])
  const child = tree.spawn(root, {
    prompt: "private",
    context: "fork",
    ephemeral: true,
    callableTools: names,
    extraTools: [make("extra_main")],
    maxTurns: 1,
  })
  await child.result()
  expect(mock.requests[0]!.tools.map((tool) => tool.name)).toEqual(["main", "extra_main", "deferred_main"])
  expect(
    agentOf(child)
      .messages.filter((message) => message.role === "toolResult")
      .map((message) => message.rejected),
  ).toEqual(["blocked", "blocked", "blocked"])
  expect(executed).toBe(0)
  const ordinary = tree.spawn(root, { prompt: "ordinary" })
  await ordinary.result()
  expect(mock.requests.at(-1)!.tools).toEqual([])
  expect(() => tree.spawn(root, { prompt: "ordinary", extraTools: [make("extra_main")] })).toThrow(
    "top-level sessions only",
  )
})

test("forked private requests align the parent's system, history prefix and deferred load order", async () => {
  const { root, tree, tools, mock } = await setup()
  for (const name of ["active", "deferred_a", "deferred_b"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        ...(name !== "active" ? { exposure: "deferred" as const } : {}),
        execute: async () => textResult("ok"),
      }),
      "test",
    )
  }
  root.loadTools(["deferred_b", "deferred_a"])
  await root.prompt("shared history")
  const parent = mock.requests[0]!
  const child = tree.spawn(root, {
    prompt: "private follow-up",
    context: "fork",
    ephemeral: true,
    callableTools: [],
    maxTurns: 1,
  })
  await child.result()
  const fork = mock.requests[1]!
  expect(fork.systemPrompt).toBe(parent.systemPrompt)
  expect(fork.tools).toEqual(parent.tools)
  expect(fork.messages.slice(0, parent.messages.length)).toEqual(parent.messages)
  expect(fork.messages.at(-1)?.content).toEqual([{ type: "text", text: "private follow-up" }])
  expect(agentOf(child).loadedTools).toEqual(["deferred_b", "deferred_a"])
  expect(root.loadedTools).toEqual(["deferred_b", "deferred_a"])
  const fresh = tree.spawn(root, { prompt: "fresh task", ephemeral: true, callableTools: [], maxTurns: 1 })
  await fresh.result()
  expect(mock.requests[2]!.tools).toEqual(parent.tools)
  expect(mock.requests[2]!.systemPrompt).toBe(parent.systemPrompt)
  expect(mock.requests[2]!.messages).toHaveLength(1)
})

test("private initial and follow-up turns use a reserved slot inside maxConcurrent", async () => {
  const { root, tree, mock } = await setup(
    (request) => ({ text: "done", delayMs: lastText(request).startsWith("public") ? 200 : 10 }),
    { maxConcurrent: 2 },
  )
  const publicChild = tree.spawn(root, { prompt: "public first" })
  const queued = tree.spawn(root, { prompt: "public queued" })
  const a = tree.spawn(root, { prompt: "private first", ephemeral: true, maxTurns: 2 })
  expect(queued.state).toBe("queued")
  await until(() => a.state === "idle")
  expect(publicChild.state).toBe("working")
  expect(a.send("private second")).toBe(true)
  expect((await a.result()).turns).toBe(2)
  expect(publicChild.state).toBe("working")
  expect(queued.state).toBe("queued")
  await publicChild.result()
  await queued.result()
  expect(mock.requests.map(lastText)).toEqual([
    "public first",
    "private first",
    "private second",
    "public queued",
  ])
})

for (const reason of ["exit", "switch"] as const) {
  test(`parent ${reason} aborts private idle, working and queued children and drains their disposal`, async () => {
    const { root, tree, mock } = await setup(
      (request) => ({ text: "done", delayMs: lastText(request) === "idle" ? 0 : 200 }),
      { maxConcurrent: 1 },
    )
    const idle = tree.spawn(root, { prompt: "idle", ephemeral: true })
    await until(() => idle.state === "idle")
    const working = tree.spawn(root, { prompt: "working", ephemeral: true })
    await until(() => working.state === "working")
    const queued = tree.spawn(root, { prompt: "queued", ephemeral: true })
    expect(queued.state).toBe("queued")
    await root.dispose(reason)
    for (const child of [idle, working, queued]) {
      expect(await child.result()).toMatchObject({ status: "aborted", error: "the session ended" })
      expect(child.send("too late")).toBe(false)
    }
    expect(mock.requests.some((request) => lastText(request) === "queued")).toBe(false)
    await tree.waitForChildren()
    expect(tree.children).toEqual([])
  })
}

test("private descendants and their groups stay private, inherit call restrictions and charge the owning store", async () => {
  const { root, tree, tools, session, bus, events } = await setup((request) =>
    lastText(request) === "lead"
      ? { toolCalls: [{ name: "spawn", args: {} }] }
      : { text: "done", usage: { input: 4, cost: 0.1 } },
  )
  let nested: ChildSession | undefined
  let groupId = ""
  tools.register(
    defineTool({
      name: "spawn",
      description: "spawn",
      parameters: { type: "object" },
      execute: async (_args, context) => {
        const group = context.session!.createGroup!({ name: "private group" })
        groupId = group.id
        nested = group.spawn({ prompt: "leaf", callableTools: ["spawn", "write"] })
        return textResult("spawned")
      },
    }),
    "test",
  )
  const child = tree.spawn(root, { prompt: "lead", ephemeral: true, callableTools: ["spawn"] })
  const streamed = collect(child)
  await until(() => child.state === "idle" && nested?.state === "idle")
  if (!nested) throw new Error("expected a private descendant")
  expect(agentOf(nested).session).toBeUndefined()
  expect(agentOf(nested).bus).toBe(agentOf(child).bus)
  expect([...(agentOf(nested).callableTools ?? [])]).toEqual(["spawn"])
  expect(tree.childrenOf(child.id)).toEqual([])
  expect(tree.subagent(nested.id)).toBeUndefined()
  expect(tree.groups()).toEqual([])
  expect(tree.group(groupId)).toBeUndefined()
  expect(tree.usage).toMatchObject({ input: 8, cost: 0.2 })
  expect(session.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(3)
  child.stop()
  expect(await child.result()).toMatchObject({ status: "done" })
  expect(await nested.result()).toMatchObject({ status: "aborted", error: "its parent ended" })
  const seen = await streamed
  const descendantId = nested.id
  expect(seen.some((event) => event.sessionId === descendantId && event.type === "turn.end")).toBe(true)
  await bus.flush()
  expect(events.filter((event) => event.type !== "budget.update")).toEqual([])
  expect(events.findLast((event) => event.type === "budget.update")).toMatchObject({
    sessionId: root.sessionId,
    data: { costUsd: 0.2 },
  })
  expect(tree.groups()).toEqual([])
})

test("callableTools also applies to ordinary children while tools and excludeTools still filter declarations", async () => {
  const { root, tree, tools, mock } = await setup((request) =>
    request.messages.at(-1)?.role === "toolResult"
      ? { text: "done" }
      : { toolCalls: [{ name: "allowed", args: {} }] },
  )
  let executed = false
  for (const name of ["allowed", "excluded", "not_selected"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        execute: async () => {
          executed = true
          return textResult("should not run")
        },
      }),
      "test",
    )
  }
  const child = tree.spawn(root, {
    prompt: "task",
    tools: ["allowed", "excluded"],
    excludeTools: ["excluded"],
    callableTools: [],
  })
  expect(await child.result()).toMatchObject({ status: "done" })
  expect(mock.requests[0]!.tools.map((tool) => tool.name)).toEqual(["allowed"])
  expect(agentOf(child).messages.find((message) => message.role === "toolResult")).toMatchObject({
    rejected: "blocked",
  })
  expect(executed).toBe(false)
})

test("private stop or abort while queued settles without calling the model and returns undelivered input", async () => {
  const { root, tree, mock } = await setup(() => ({ text: "busy", delayMs: 40 }), { maxConcurrent: 1 })
  const busy = tree.spawn(root, { prompt: "busy" })
  const stopped = tree.spawn(root, { prompt: "stopped", ephemeral: true })
  const aborted = tree.spawn(root, { prompt: "aborted", ephemeral: true })
  stopped.send("never delivered")
  stopped.stop("cancelled before starting")
  aborted.abort("aborted before starting")
  expect(await stopped.result()).toMatchObject({
    status: "done",
    turns: 0,
    note: "cancelled before starting",
    undelivered: [userMessage("never delivered")],
  })
  expect(await aborted.result()).toMatchObject({
    status: "aborted",
    turns: 0,
    error: "aborted before starting",
  })
  await busy.result()
  expect(mock.requests.map(lastText)).toEqual(["busy"])
  expect(stopped.send("late")).toBe(false)
})

test("a private failed turn ends, rejects later sends and still charges its usage", async () => {
  const { root, tree, session } = await setup(() => ({
    error: { message: "private failure" },
    usage: { input: 2, cost: 0.05 },
  }))
  const child = tree.spawn(root, { prompt: "task", ephemeral: true })
  const streamed = collect(child)
  expect(await child.result()).toMatchObject({
    status: "error",
    error: expect.stringContaining("private failure"),
    usage: { input: 2, cost: 0.05 },
  })
  expect((await streamed).at(-1)?.type).toBe("subagent.end")
  expect(child.send("late")).toBe(false)
  expect(tree.subagent(child.id)).toBeUndefined()
  expect(session.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(1)
})

test("private child output saves, including empty output, never create artifact files", async () => {
  const { root, tree } = await setup()
  const child = tree.spawn(root, { prompt: "task", ephemeral: true })
  await until(() => child.state === "idle")
  const artifacts = agentOf(child).artifacts
  for (const text of ["", "private output".repeat(10_000)]) {
    await expect(artifacts.save({ text, tool: "read" })).rejects.toThrow(
      "Private sessions cannot save output files",
    )
  }
  expect(artifacts.list()).toEqual([])
  expect(existsSync(artifacts.dir)).toBe(false)
  child.abort()
  expect(await child.result()).toMatchObject({ status: "aborted" })
})

test("private children still respect depth, group limits and incompatible schema validation", async () => {
  const { root, tree } = await setup(() => ({ text: "done" }), { maxDepth: 1 })
  expect(() => tree.spawn(root, { prompt: "task", ephemeral: true, schema: { type: "string" } })).toThrow(
    "persistent sub-agent cannot have a result schema",
  )
  const group = tree.createGroup(root, { name: "limited", maxAgents: 1, maxTurnsPerAgent: 1 })
  const child = group.spawn({ prompt: "task", ephemeral: true })
  expect(group.children()).toEqual([])
  expect(() => group.spawn({ prompt: "extra", ephemeral: true })).toThrow("limit of 1")
  expect(() => tree.spawn(agentOf(child), { prompt: "too deep" })).toThrow("at most 1 level")
  expect(await child.result()).toMatchObject({
    status: "done",
    turns: 1,
    note: "reached its limit of 1 turn",
  })
  expect(group.children()).toEqual([])
})
