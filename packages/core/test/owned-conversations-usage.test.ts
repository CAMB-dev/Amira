import { afterEach, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  addUsage,
  createAi,
  createMockDialect,
  emptyUsage,
  type MockReply,
  type ModelRequest,
  type Usage,
} from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { conversationUsage } from "../src/conversation-usage.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { subagentsOf } from "../src/subagent-list.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("historical child accounting includes compaction charges", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-owned-usage-"))
  try {
    const root = SessionStore.create({ cwd: dir, dir, id: "root" })
    root.appendMessage({ role: "user", content: [{ type: "text", text: "root" }] })
    const child = SessionStore.create({
      cwd: dir,
      dir: path.join(dir, "subagents"),
      id: "child",
      parent: root.id,
    })
    child.appendMessage({ role: "user", content: [{ type: "text", text: "task" }] })
    child.append({
      type: "compaction",
      summary: "summary",
      replaces: [],
      usage: { ...emptyUsage(), input: 7, cost: 0.25 },
    })
    root.append({ type: "subagent", childSessionId: child.id, role: "worker" })
    expect(subagentsOf(root.id, SessionStore.open(root.file))[0]?.info.usage).toMatchObject({
      input: 7,
      cost: 0.25,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const dirs: string[] = []
const agents: Agent[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(reply: (request: ModelRequest) => MockReply = () => ({ text: "done", usage: priced(1) })) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-owned-usage-"))
  dirs.push(dir)
  const mock = createMockDialect()
  for (let i = 0; i < 30; i++) mock.push(reply)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const tree = new AgentTree({ ai, sections: () => [] })
  const tools = new ToolRegistry()
  const session = SessionStore.create({ cwd: dir, dir })
  const agent = new Agent({
    ai,
    tree,
    tools,
    session,
    cwd: dir,
    bus: new EventBus(),
    model: ai.model("mock/m"),
  })
  agents.push(agent)
  return { dir, ai, tree, tools, session, agent }
}

function priced(cost: number): Usage {
  return { ...emptyUsage(), input: 10, output: 2, cost }
}

function side(session: SessionStore, usage: Usage) {
  session.append({ type: "side_usage", model: { provider: "mock", model: "m" }, usage })
}

test("one owning root excludes main and other scopes, and updates before budget notification", async () => {
  const { agent, tree } = setup()
  const other = setup()
  const main = setup()
  await Promise.all([agent.prompt("owned"), other.agent.prompt("other"), main.agent.prompt("main")])
  let notified = 0
  let notifiedCost = 0
  const dispose = agent.bus.subscribe(
    () => {
      notified++
      notifiedCost = conversationUsage(agent).own.knownCostUsd
    },
    { types: ["budget.update"] },
  )
  tree.recordUsage(agent, priced(2))
  await agent.bus.flush()
  dispose()
  expect(notified).toBe(1)
  expect(notifiedCost).toBe(3)
  expect(conversationUsage(agent).total.knownCostUsd).toBe(3)
  expect(conversationUsage(other.agent).total.knownCostUsd).toBe(1)
  expect(conversationUsage(main.agent).total.knownCostUsd).toBe(1)
})

test("root, nested children and sibling groups roll up once and survive restart", async () => {
  const { agent, tree, tools, session } = setup((request) =>
    request.systemPrompt.includes("LEADER") && request.messages.at(-1)?.role !== "toolResult"
      ? { toolCalls: [{ name: "spawn_leaf", args: {} }], usage: priced(1) }
      : { text: "done", usage: priced(1) },
  )
  tools.register(
    defineTool({
      name: "spawn_leaf",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        await ctx.session!.spawn!({ prompt: "leaf" }).result()
        return textResult("done")
      },
    }),
    "test",
  )
  await agent.prompt("root")
  const group = tree.createGroup(agent, { name: "one" })
  const leader = group.spawn({ prompt: "leader", systemPrompt: "LEADER" })
  await leader.result()
  const sibling = tree.createGroup(agent, { name: "two" }).spawn({ prompt: "sibling" })
  await sibling.result()
  const live = conversationUsage(agent)
  expect(live.own.knownCostUsd).toBe(1)
  expect(live.total.knownCostUsd).toBe(5)
  expect(live.descendants).toHaveLength(3)
  expect(live.descendants.find((row) => row.sessionId === leader.id)?.groupId).toBe(group.id)
  expect(live.descendants.find((row) => row.sessionId === sibling.id)?.usage.knownCostUsd).toBe(1)
  expect(conversationUsage(SessionStore.open(session.file))).toEqual(live)
})

test("private nested receipts reconstruct children without transcripts or double charging own", async () => {
  const { agent, tree, tools, session } = setup((request) =>
    request.systemPrompt.includes("PRIVATE_LEADER") && request.messages.at(-1)?.role !== "toolResult"
      ? { toolCalls: [{ name: "private_leaf", args: {} }], usage: priced(1) }
      : { text: "PRIVATE ANSWER", usage: priced(1) },
  )
  tools.register(
    defineTool({
      name: "private_leaf",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        await ctx.session!.spawn!({
          prompt: "SECRET PROMPT",
          title: "private leaf",
          ephemeral: true,
          maxTurns: 1,
        }).result()
        return textResult("done")
      },
    }),
    "test",
  )
  await agent.prompt("root")
  const group = tree.createGroup(agent, { name: "private group" })
  const child = group.spawn({
    prompt: "SECRET PROMPT",
    title: "private leader",
    ephemeral: true,
    maxTurns: 1,
    systemPrompt: "PRIVATE_LEADER",
  })
  await child.result()
  const live = conversationUsage(agent)
  expect(live.own.knownCostUsd).toBe(1)
  expect(live.total.knownCostUsd).toBe(4)
  expect(live.descendants).toHaveLength(2)
  expect(live.descendants.find((row) => row.sessionId === child.id)).toMatchObject({
    ephemeral: true,
    groupId: group.id,
    usage: { knownCostUsd: 2 },
  })
  const raw = readFileSync(session.file, "utf8")
  expect(raw).not.toContain("SECRET PROMPT")
  // Root's own answer may be public, but no private transcript is retained.
  expect(session.entries.filter((entry) => entry.type === "subagent")).toHaveLength(0)
  expect(conversationUsage(SessionStore.open(session.file))).toEqual(live)
})

test("old anonymous private receipts remain in own, and historical branches retain spending", () => {
  const { session } = setup()
  side(session, priced(2))
  const child = SessionStore.create({
    cwd: session.header.cwd,
    dir: path.join(path.dirname(session.file), "subagents"),
    parent: session.id,
    id: "old_child",
  })
  side(child, priced(3))
  session.append({ type: "subagent", childSessionId: child.id, role: "worker" })
  session.append({ type: "checkout", target: null })
  const snapshot = conversationUsage(SessionStore.open(session.file))
  expect(snapshot.own.knownCostUsd).toBe(2)
  expect(snapshot.total.knownCostUsd).toBe(5)
  expect(snapshot.descendants.map((row) => row.sessionId)).toEqual([child.id])
})

test("known subtotal and estimate coverage survive JSON and mixed aggregate persistence", () => {
  const { session } = setup()
  const aggregate = addUsage(priced(2), { ...emptyUsage(), webSearchRequests: 1 })
  expect(aggregate.cost).toBeUndefined()
  side(session, aggregate)
  side(session, { ...priced(1), pricingUnknown: true })
  const snapshot = conversationUsage(SessionStore.open(session.file))
  expect(JSON.parse(JSON.stringify(snapshot)).total).toMatchObject({
    knownCostUsd: 3,
    complete: false,
    usage: { pricingUnknown: true },
  })
  expect(snapshot.total.usage.cost).toBeUndefined()
})

test("snapshots are frozen and detached, independent of event delivery", () => {
  const { agent, tree } = setup()
  tree.recordUsage(agent, priced(1))
  const first = conversationUsage(agent)
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(first.own.usage)).toBe(true)
  expect(Object.isFrozen(first.descendants)).toBe(true)
  tree.recordUsage(agent, priced(2))
  const latest = conversationUsage(agent)
  expect(first.total.knownCostUsd).toBe(1)
  expect(latest.total.knownCostUsd).toBe(3)
  expect(latest.revision).toBeGreaterThan(first.revision)
})

test("missing descendants and damaged receipt lines cannot certify complete zero usage", () => {
  const { session } = setup()
  side(session, priced(1))
  session.append({ type: "subagent", childSessionId: "missing", role: "worker" })
  appendFileSync(session.file, "{torn receipt\n")
  const snapshot = conversationUsage(SessionStore.open(session.file))
  expect(snapshot.own.knownCostUsd).toBe(1)
  expect(snapshot.own.complete).toBe(false)
  expect(snapshot.total.complete).toBe(false)
  expect(snapshot.descendants[0]?.usage.complete).toBe(false)
})

test("unpersisted receipts remain visible and incomplete after a disk failure", () => {
  const { agent, tree, session } = setup()
  side(session, priced(1))
  // Corrupt the writer generation, without touching any user's real files.
  writeFileSync(session.file, "invalid\n")
  tree.recordUsage(agent, priced(2))
  const snapshot = conversationUsage(agent)
  expect(snapshot.own.knownCostUsd).toBe(3)
  expect(snapshot.own.complete).toBe(false)
  expect(() => SessionStore.open(session.file)).toThrow()
})

test("persisted receipt identity survives reused mutable provider usage objects", () => {
  const { agent, tree, session } = setup()
  const usage = priced(1)
  side(session, usage)
  tree.recordUsage(agent, usage)
  expect(conversationUsage(agent).total.knownCostUsd).toBe(1)
  usage.cost = 2
  expect(conversationUsage(agent).total.knownCostUsd).toBe(1)
  side(session, usage)
  tree.recordUsage(agent, usage)
  expect(conversationUsage(agent).total.knownCostUsd).toBe(3)
  expect(conversationUsage(SessionStore.open(session.file))).toEqual(conversationUsage(agent))
})
