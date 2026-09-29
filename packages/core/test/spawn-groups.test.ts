import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type AnyEvent, type Budget, type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { AgentTree, SpawnError } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function setup(
  reply: (req: ModelRequest) => MockReply,
  opts: { maxConcurrent?: number; budget?: Budget; maxDepth?: number } = {},
) {
  const mock = createMockDialect()
  for (let i = 0; i < 200; i++) mock.push(reply)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }], ...opts })
  const tools = new ToolRegistry()
  const root = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "root",
    bus,
    tree,
    tools,
  })
  return { mock, bus, events, tree, tools, root }
}

const roleOf = (req: ModelRequest) => /ROLE (\w+)/.exec(req.systemPrompt)?.[1] ?? "root"
const lastText = (req: ModelRequest) =>
  req.messages
    .at(-1)
    ?.content.map((b) => (b.type === "text" ? b.text : ""))
    .join("") ?? ""

/** Peak number of child turns running at once, among `ids` (all children when unset). */
function peakTurns(bus: EventBus, root: Agent, ids?: () => Set<string>) {
  let running = 0
  const peak = { value: 0 }
  bus.subscribe(
    (e) => {
      if (e.sessionId === root.sessionId || (ids && !ids().has(e.sessionId))) return
      if (e.type === "turn.start") peak.value = Math.max(peak.value, ++running)
      if (e.type === "turn.end") running--
    },
    { types: ["turn.start", "turn.end"] },
  )
  return peak
}

/** Waits until `done` holds, checking every few milliseconds. */
async function until(done: () => boolean) {
  while (!done()) await Bun.sleep(2)
}

// ---- spawn groups ----

test("a group runs at most its maxConcurrent children at once and reports itself by events", async () => {
  const { tree, root, bus, events } = setup(() => ({
    text: "x",
    delayMs: 15,
    usage: { input: 3, output: 2 },
  }))
  const peak = peakTurns(bus, root)
  const group = tree.createGroup(root, { name: "  review   pass ", maxConcurrent: 2 })
  expect(group.name).toBe("review pass")
  const kids = [1, 2, 3, 4, 5].map((i) => group.spawn({ prompt: `t${i}` }))
  expect(kids.every((k) => k.groupId === group.id)).toBe(true)
  expect(group.info().agents).toMatchObject({ total: 5, working: 0, queued: 5 })
  const results = await Promise.all(kids.map((k) => k.result()))
  expect(results.every((r) => r.status === "done")).toBe(true)
  expect(peak.value).toBe(2)
  const info = group.info()
  expect(info).toMatchObject({ state: "active", tokens: 25, agents: { total: 5, ended: 5 } })
  group.end()
  expect(await group.ended()).toMatchObject({ state: "ended", endReason: "ended by its owner" })
  await bus.flush()
  const types = events.filter((e) => e.type.startsWith("group.")).map((e) => e.type)
  expect(types[0]).toBe("group.start")
  expect(types.at(-1)).toBe("group.end")
  expect(types.filter((t) => t === "group.update").length).toBeGreaterThan(5)
  const start = events.find((e) => e.type === "subagent.start")!
  expect(start.data).toMatchObject({ groupId: group.id })
  expect(tree.groups().map((g) => g.id)).toEqual([group.id])
})

test("the tree's maxConcurrent still holds over a group, and a full group does not hold up others", async () => {
  const { tree, root, bus } = setup(() => ({ text: "x", delayMs: 20 }), { maxConcurrent: 3 })
  const narrow = tree.createGroup(root, { name: "narrow", maxConcurrent: 1 })
  const members = new Set<string>()
  const narrowPeak = peakTurns(bus, root, () => members)
  const all = peakTurns(bus, root)
  const a = [1, 2, 3].map(() => narrow.spawn({ prompt: "n" }))
  for (const k of a) members.add(k.id)
  // Spawned after the group's queue, but not stuck behind it.
  const free = [1, 2, 3].map(() => tree.spawn(root, { prompt: "f" }))
  const firstFree = await free[0]!.result()
  expect(firstFree.status).toBe("done")
  // The free ones finish before the narrow group's third one could have started.
  expect(a[2]!.state).toBe("queued")
  await Promise.all([...a, ...free].map((k) => k.result()))
  expect(narrowPeak.value).toBe(1)
  expect(all.value).toBe(3)
})

test("maxAgents counts every child the group started, its members' own ones too", async () => {
  const { tree, root, tools } = setup((req) =>
    roleOf(req) === "lead" && req.messages.at(-1)?.role !== "toolResult"
      ? { toolCalls: [{ name: "helper", args: {} }] }
      : { text: "ok" },
  )
  let refused = ""
  tools.register(
    defineTool({
      name: "helper",
      description: "helper",
      parameters: { type: "object", properties: {} },
      execute: async (_p, ctx) => {
        const first = ctx.session!.spawn!({ prompt: "help" })
        try {
          ctx.session!.spawn!({ prompt: "more help" })
        } catch (err) {
          refused = err instanceof SpawnError ? err.message : String(err)
        }
        return textResult((await first.result()).text)
      },
    }),
    "t",
  )
  const group = tree.createGroup(root, { name: "wf", maxAgents: 2 })
  const lead = group.spawn({ prompt: "lead", systemPrompt: "ROLE lead" })
  expect((await lead.result()).status).toBe("done")
  expect(refused).toBe('the group "wf" has started its limit of 2 sub-agents')
  expect(() => group.spawn({ prompt: "third" })).toThrow(
    'the group "wf" has started its limit of 2 sub-agents',
  )
  expect(group.info().agents.total).toBe(2)
  // The tree itself is not limited by it.
  expect((await tree.spawn(root, { prompt: "outside" }).result()).status).toBe("done")
})

test("going over a group's budget stops its children with a reason and ends the group", async () => {
  const { tree, root, bus, events } = setup(
    (req) =>
      roleOf(req) === "spender"
        ? { text: "spent", usage: { input: 60, output: 10 } }
        : { text: "slow", delayMs: 300, usage: { input: 1 } },
    { budget: { tokens: 1000 } },
  )
  const group = tree.createGroup(root, { name: "wf", budget: { tokens: 50, costUsd: 5 } })
  expect(group.info().limits.budget).toEqual({ tokens: 50, costUsd: 5 })
  const slow = group.spawn({ prompt: "wait", systemPrompt: "ROLE slow" })
  const spender = group.spawn({ prompt: "spend", systemPrompt: "ROLE spender" })
  const outside = tree.spawn(root, { prompt: "outside", systemPrompt: "ROLE other" })
  await spender.result()
  const r = await slow.result()
  expect(r.status).toBe("aborted")
  expect(r.error).toBe('the group "wf" ran out of budget (70 tokens used, limit 50)')
  const info = await group.ended()
  expect(info).toMatchObject({ state: "ended", exceeded: true })
  expect(info.tokens).toBeGreaterThanOrEqual(70)
  expect(info.endReason).toContain("ran out of budget")
  expect(() => group.spawn({ prompt: "more" })).toThrow('the group "wf" has ended')
  // The rest of the tree carries on.
  expect((await outside.result()).status).toBe("done")
  await bus.flush()
  expect(events.find((e) => e.type === "group.end")?.data.group).toMatchObject({ exceeded: true })
  expect(events.some((e) => e.type === "budget.exceeded")).toBe(false)
})

test("a group's budget is cut to what the tree has left", async () => {
  const { tree, root } = setup(() => ({ text: "x", usage: { input: 30 } }), { budget: { tokens: 100 } })
  await tree.spawn(root, { prompt: "a" }).result()
  const group = tree.createGroup(root, { name: "g", budget: { tokens: 500 } })
  expect(group.info().limits.budget).toEqual({ tokens: 70 })
  // A cost limit the tree does not have stays as asked.
  expect(tree.createGroup(root, { name: "h", budget: { costUsd: 2 } }).info().limits.budget).toEqual({
    costUsd: 2,
  })
})

test("ending a group aborts its running children and stops the idle ones", async () => {
  const { tree, root } = setup((req) =>
    roleOf(req) === "slow" ? { text: "x", delayMs: 300 } : { text: "idle now" },
  )
  const group = tree.createGroup(root, { name: "g" })
  const slow = group.spawn({ prompt: "s", systemPrompt: "ROLE slow" })
  const idle = group.spawn({ prompt: "p", persistent: true })
  await until(() => idle.state === "idle")
  expect(group.children().map((c) => c.id)).toEqual([slow.id, idle.id])
  group.end("the workflow was cancelled")
  expect(group.info().state).toBe("ending")
  expect(await slow.result()).toMatchObject({ status: "aborted", error: "the workflow was cancelled" })
  expect(await idle.result()).toMatchObject({ status: "done", note: "the workflow was cancelled" })
  expect((await group.ended()).state).toBe("ended")
  // Ending again does nothing.
  group.end("again")
  expect(group.info().endReason).toBe("the workflow was cancelled")
})

test("a group created by a member is part of the member's group", async () => {
  const { tree, root, tools } = setup((req) =>
    roleOf(req) === "lead" && req.messages.at(-1)?.role !== "toolResult"
      ? { toolCalls: [{ name: "fan", args: {} }] }
      : { text: "ok", usage: { input: 5 } },
  )
  let inner: string | undefined
  tools.register(
    defineTool({
      name: "fan",
      description: "fan",
      parameters: { type: "object", properties: {} },
      execute: async (_p, ctx) => {
        const g = ctx.session!.createGroup!({ name: "inner", maxAgents: 5 })
        inner = g.id
        const kids = [g.spawn({ prompt: "a" }), g.spawn({ prompt: "b" })]
        await Promise.all(kids.map((k) => k.result()))
        g.end()
        return textResult("fanned")
      },
    }),
    "t",
  )
  const outer = tree.createGroup(root, { name: "outer", maxAgents: 3 })
  await outer.spawn({ prompt: "lead", systemPrompt: "ROLE lead" }).result()
  const groups = tree.groups()
  expect(groups.map((g) => g.name)).toEqual(["outer", "inner"])
  const innerInfo = groups.find((g) => g.id === inner)!
  expect(innerInfo.agents.total).toBe(2)
  expect(innerInfo.tokens).toBe(10)
  // The outer group counts the lead and both of the inner group's children.
  expect(outer.info().agents.total).toBe(3)
  // The lead's own reply and the inner children's.
  expect(outer.info().tokens).toBe(15)
  expect(() => outer.spawn({ prompt: "fourth" })).toThrow(SpawnError)
})

// ---- persistent children ----

test("a persistent child goes idle after a turn, a message wakes it, and stop ends it", async () => {
  const { tree, root, bus, events } = setup((req) => ({ text: `re: ${lastText(req)}`, usage: { input: 1 } }))
  const child = tree.spawn(root, { prompt: "hello", persistent: true })
  expect(child.persistent).toBe(true)
  await until(() => child.state === "idle")
  expect(child.turns).toBe(1)
  expect(child.send("second")).toBe(true)
  await Bun.sleep(1)
  await until(() => child.state === "idle")
  expect(child.turns).toBe(2)
  // A notice announced by a tool (or an extension) wakes it too.
  const notice = child.expectNotice()
  notice.deliver({ role: "user", content: [{ type: "text", text: "third" }] })
  await Bun.sleep(1)
  await until(() => child.state === "idle")
  child.stop("the swarm is done")
  const r = await child.result()
  expect(r).toMatchObject({ status: "done", note: "the swarm is done", turns: 3, text: "re: third" })
  expect(child.send("late")).toBe(false)
  await bus.flush()
  const states = events.flatMap((e) =>
    e.type === "subagent.state" ? [`${e.data.state}:${e.data.turns}`] : [],
  )
  expect(states).toEqual([
    "working:1",
    "idle:1",
    "queued:1",
    "working:2",
    "idle:2",
    "queued:2",
    "working:3",
    "idle:3",
  ])
  expect(events.find((e) => e.type === "subagent.start")?.data).toMatchObject({ persistent: true })
  expect(events.find((e) => e.type === "subagent.end")?.data).toMatchObject({
    status: "done",
    note: "the swarm is done",
    turns: 3,
  })
  const listed = tree.subagent(child.id)?.info
  expect(listed).toMatchObject({ status: "done", persistent: true, turns: 3, note: "the swarm is done" })
})

test("messages sent together start one turn", async () => {
  const { tree, root, mock } = setup(() => ({ text: "ok", delayMs: 5 }))
  const child = tree.spawn(root, { prompt: "start", persistent: true })
  await until(() => child.state === "idle")
  child.send("one")
  child.send("two")
  await Bun.sleep(1)
  await until(() => child.state === "idle")
  expect(child.turns).toBe(2)
  expect(lastText(mock.requests.at(-1)!)).toContain("one")
  expect(lastText(mock.requests.at(-1)!)).toContain("two")
  child.stop()
  expect((await child.result()).status).toBe("done")
})

test("a message sent during a turn starts the next one without going idle", async () => {
  const { tree, root, mock, bus, events } = setup(() => ({ text: "ok", delayMs: 30 }))
  const child = tree.spawn(root, { prompt: "start", persistent: true })
  await until(() => child.state === "working")
  await Bun.sleep(5)
  child.send("more")
  await until(() => child.state === "idle")
  expect(child.turns).toBe(2)
  expect(lastText(mock.requests.at(-1)!)).toBe("more")
  child.stop()
  await child.result()
  await bus.flush()
  const states = events.flatMap((e) =>
    e.type === "subagent.state" ? [`${e.data.state}:${e.data.turns}`] : [],
  )
  expect(states).toEqual(["working:1", "working:2", "idle:2"])
})

test("stopping during a turn ends the child after it; messages still waiting are not run", async () => {
  const { tree, root, mock } = setup(() => ({ text: "ok", delayMs: 30 }))
  const child = tree.spawn(root, { prompt: "start", persistent: true })
  await until(() => child.state === "working")
  await Bun.sleep(5)
  child.stop("enough")
  expect(child.send("more")).toBe(false)
  const r = await child.result()
  expect(r).toMatchObject({ status: "done", note: "enough", turns: 1, text: "ok" })
  expect(mock.requests).toHaveLength(1)
})

test("maxTurns ends a persistent child after its last turn; a group's maxTurnsPerAgent too", async () => {
  const { tree, root } = setup(() => ({ text: "ok" }))
  const child = tree.spawn(root, { prompt: "start", persistent: true, maxTurns: 2 })
  await until(() => child.state === "idle")
  child.send("again")
  const r = await child.result()
  expect(r).toMatchObject({ status: "done", turns: 2, note: "reached its limit of 2 turns" })

  const group = tree.createGroup(root, { name: "swarm", maxTurnsPerAgent: 1 })
  const member = group.spawn({ prompt: "only once", persistent: true, maxTurns: 5 })
  expect(await member.result()).toMatchObject({
    status: "done",
    turns: 1,
    note: "reached its limit of 1 turn",
  })
})

test("an idle persistent child does not hold a place: others run meanwhile", async () => {
  const { tree, root } = setup(() => ({ text: "ok", delayMs: 5 }), { maxConcurrent: 1 })
  const resident = tree.spawn(root, { prompt: "live", persistent: true })
  const oneShot = tree.spawn(root, { prompt: "quick" })
  expect((await oneShot.result()).status).toBe("done")
  expect(resident.state).toBe("idle")
  // Woken while another child holds the only place, it waits for it.
  const blocker = tree.spawn(root, { prompt: "block" })
  resident.send("wake")
  await Bun.sleep(1)
  expect(resident.state).toBe("queued")
  await blocker.result()
  await until(() => resident.turns >= 2 && resident.state === "idle")
  resident.stop()
  expect((await resident.result()).turns).toBe(2)
})

test("aborting an idle persistent child ends it as aborted; a failed turn ends it with an error", async () => {
  const { tree, root } = setup((req) =>
    lastText(req) === "break" ? { error: { message: "boom" } } : { text: "ok" },
  )
  const a = tree.spawn(root, { prompt: "a", persistent: true })
  await until(() => a.state === "idle")
  a.abort("not needed")
  expect(await a.result()).toMatchObject({ status: "aborted", error: "not needed" })

  const b = tree.spawn(root, { prompt: "b", persistent: true })
  await until(() => b.state === "idle")
  b.send("break")
  const r = await b.result()
  expect(r.status).toBe("error")
  expect(r.error).toContain("boom")
})

test("only persistent children take messages; tree.deliver reaches them by id", async () => {
  const { tree, root } = setup(() => ({ text: "ok", delayMs: 5 }))
  const once = tree.spawn(root, { prompt: "x" })
  expect(once.send("hi")).toBe(false)
  expect(() => once.expectNotice()).toThrow("only a persistent sub-agent")
  const resident = tree.spawn(root, { prompt: "y", persistent: true })
  await until(() => resident.state === "idle")
  expect(tree.deliver(resident.id, "by id")).toBe(true)
  expect(tree.deliver("s_unknown", "x")).toBe(false)
  await Bun.sleep(1)
  await until(() => resident.state === "idle")
  expect(resident.turns).toBe(2)
  resident.stop()
  await Promise.all([once.result(), resident.result()])
})

test("a persistent child's tools can announce notices: its background work wakes it", async () => {
  const { tree, root, tools } = setup((req) => {
    if (roleOf(req) !== "resident") return { text: "ok" }
    const last = lastText(req)
    if (last === "start") return { toolCalls: [{ name: "later", args: {} }] }
    return { text: `got: ${last}` }
  })
  let offered = false
  tools.register(
    defineTool({
      name: "later",
      description: "later",
      parameters: { type: "object", properties: {} },
      execute: async (_p, ctx) => {
        offered = ctx.session?.expectNotice !== undefined
        const notice = ctx.session!.expectNotice!()
        setTimeout(
          () => notice.deliver({ role: "user", content: [{ type: "text", text: "background result" }] }),
          20,
        )
        return textResult("started")
      },
    }),
    "t",
  )
  const resident = tree.spawn(root, { prompt: "start", systemPrompt: "ROLE resident", persistent: true })
  await until(() => resident.turns >= 2 && resident.state === "idle")
  expect(offered).toBe(true)
  resident.stop()
  expect((await resident.result()).text).toBe("got: background result")
})

test("persistent children count against their group; an ended group stops its idle ones", async () => {
  const { tree, root } = setup(() => ({ text: "ok" }))
  const group = tree.createGroup(root, { name: "swarm", maxAgents: 2, maxConcurrent: 1 })
  const a = group.spawn({ prompt: "a", persistent: true })
  const b = group.spawn({ prompt: "b", persistent: true })
  expect(() => group.spawn({ prompt: "c", persistent: true })).toThrow(SpawnError)
  await until(() => a.state === "idle" && b.state === "idle")
  expect(group.info().agents).toMatchObject({ total: 2, idle: 2, working: 0 })
  group.end("swarm finished")
  const [ra, rb] = await Promise.all([a.result(), b.result()])
  expect(ra).toMatchObject({ status: "done", note: "swarm finished" })
  expect(rb).toMatchObject({ status: "done", note: "swarm finished" })
  expect((await group.ended()).agents).toMatchObject({ total: 2, ended: 2 })
})

test("messages that never reached a child's model come back in its result, e.g. after a failed turn", async () => {
  const { tree, root, mock, bus, events } = setup((req) =>
    lastText(req) === "break" ? { error: { message: "boom" }, delayMs: 20 } : { text: "ok" },
  )
  const child = tree.spawn(root, { prompt: "a", persistent: true })
  await until(() => child.state === "idle")
  expect(child.send("break")).toBe(true)
  await until(() => child.state === "working")
  await Bun.sleep(5)
  expect(child.send("important follow-up")).toBe(true)
  const r = await child.result()
  expect(r.status).toBe("error")
  expect(r.undelivered?.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))).toEqual(
    ["important follow-up"],
  )
  expect(mock.requests.some((q) => lastText(q).includes("important follow-up"))).toBe(false)
  await bus.flush()
  const end = events.find((e) => e.type === "subagent.end")
  expect(end?.type === "subagent.end" && end.data.undelivered).toBe(1)
  // Nothing is sent again later by itself.
  expect(events.some((e) => e.type === "notice.retry")).toBe(false)
})

test("a child that ends aborts the sub-agents it left running, persistent or not", async () => {
  const { tree, root, tools } = setup((req) =>
    roleOf(req) === "lead" && req.messages.at(-1)?.role !== "toolResult"
      ? { toolCalls: [{ name: "fire", args: {} }] }
      : roleOf(req) === "slow"
        ? { text: "slow done", delayMs: 400 }
        : { text: "ok" },
  )
  let grandchild: ChildSession | undefined
  tools.register(
    defineTool({
      name: "fire",
      description: "fire",
      parameters: { type: "object", properties: {} },
      execute: async (_p, ctx) => {
        grandchild = ctx.session!.spawn!({ prompt: "helper", systemPrompt: "ROLE slow" })
        return textResult("started")
      },
    }),
    "t",
  )
  const lead = tree.spawn(root, { prompt: "go", systemPrompt: "ROLE lead", persistent: true })
  await until(() => lead.state === "idle")
  expect(grandchild?.state).toBe("working")
  lead.stop()
  expect(await lead.result()).toMatchObject({ status: "done" })
  expect(await grandchild!.result()).toMatchObject({ status: "aborted", error: "its parent ended" })
  expect(tree.children).toHaveLength(0)
})

// ---- extra tools ----

test("a child's extra tools are its own: they know the child, win over the parent's and are hidden from its children", async () => {
  const seen: Record<string, string[]> = {}
  const { tree, root, tools } = setup((req) => {
    const role = roleOf(req)
    seen[role] = req.tools.map((t) => t.name).sort()
    if (req.messages.at(-1)?.role === "toolResult") return { text: `${role}: ${lastText(req)}` }
    return { toolCalls: [{ name: role === "b" ? "nest" : "whoami", args: {} }] }
  })
  tools.register(
    defineTool({
      name: "whoami",
      description: "the shared one",
      parameters: { type: "object" },
      execute: async () => textResult("nobody"),
    }),
    "test",
  )
  tools.register(
    defineTool({
      name: "nest",
      description: "starts a grandchild",
      parameters: { type: "object" },
      execute: async (_p, ctx) => {
        const r = await ctx.session!.spawn!({ prompt: "g", systemPrompt: "ROLE g" }).result()
        return textResult(r.text)
      },
    }),
    "test",
  )
  const own = (name: string) =>
    defineTool({
      name: "whoami",
      description: `only ${name}'s`,
      parameters: { type: "object" },
      execute: async () => textResult(`I am ${name}`),
    })
  const ping = defineTool({
    name: "ping",
    description: "b's own",
    parameters: { type: "object" },
    execute: async () => textResult("pong"),
  })
  const a = tree.spawn(root, { prompt: "a", systemPrompt: "ROLE a", extraTools: [own("a")] })
  const b = tree.spawn(root, { prompt: "b", systemPrompt: "ROLE b", extraTools: [own("b"), ping] })
  const [ra, rb] = await Promise.all([a.result(), b.result()])
  expect(ra.text).toBe("a: I am a")
  // The grandchild gets neither of b's own tools, nor the shared tool b's whoami hides.
  expect(rb.text).toBe('b: g: Unknown tool "whoami". Available tools: nest')
  expect(seen.b).toEqual(["nest", "ping", "whoami"])
  expect(seen.g).toEqual(["nest"])
  expect(() => tree.spawn(root, { prompt: "x", extraTools: [{ ...ping, name: "return_result" }] })).toThrow(
    SpawnError,
  )
})
