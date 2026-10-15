import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, emptyUsage, type MockStep, type Usage } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"
import { listSubagents, subagentsOf } from "../src/subagent-list.ts"
import { BudgetLedger } from "../src/subagents/budget.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup(steps: MockStep[], fallback = false, premiumPrices = true) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-fast-accounting-"))
  const session = SessionStore.create({ cwd: home, dir: path.join(home, "sessions") })
  session.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } })
  const mock = createMockDialect(steps)
  const dialect = {
    ...mock,
    id: "anthropic-messages",
    async *stream(...args: Parameters<typeof mock.stream>) {
      if (fallback) {
        yield {
          type: "request.end" as const,
          message: {
            role: "assistant" as const,
            model: { provider: args[0].model.provider, model: args[0].model.id },
            content: [],
            usage: { ...emptyUsage(), input: 10_000, speed: "fast" as const },
          },
        }
        yield { type: "fast.fallback" as const }
      }
      yield* mock.stream(...args)
    },
  }
  const ai = createAi({
    dialects: [dialect],
    providers: [
      {
        id: "mock",
        dialect: dialect.id,
        baseUrl: "https://provider.invalid",
        defaultModel: {
          fast: { kind: "anthropic-speed" },
          ...(fallback
            ? {
                cost: {
                  input: 7.5,
                  output: 0,
                  ...(premiumPrices ? { fast: { input: 8, output: 0 } } : {}),
                },
              }
            : {}),
        },
      },
    ],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const parent = new Agent({
    ai,
    model: ai.model("mock/fast"),
    cwd: home,
    session,
    tree,
    sections: [],
    fastMode: true,
  })
  cleanups.push(async () => {
    tree.abortAll("test cleanup")
    await parent.dispose()
    await tree.waitForChildren()
    rmSync(home, { recursive: true, force: true })
  })
  return { parent, tree, session, home, mock }
}

for (const premiumPrices of [true, false]) {
  test(`live and restored child bill the fast fallback once, with ${premiumPrices ? "confirmed" : "estimated"} pricing`, async () => {
    const { parent, tree, session, mock } = setup(
      [{ text: "done", usage: { input: 100, speed: "standard" } }],
      true,
      premiumPrices,
    )
    const group = tree.createGroup(parent, { name: "work" })
    const child = group.spawn({ prompt: "work" })
    const result = await child.result()
    expect(result.error).toBeUndefined()
    expect(result.status).toBe("done")
    expect(mock.requests).toHaveLength(1)
    const cost = premiumPrices ? 0.08075 : 0.07575
    const live = listSubagents(parent, tree)[0]!
    const reopened = SessionStore.open(live.file!)
    const sides = reopened.entries.filter((e) => e.type === "side_usage")
    expect(sides).toHaveLength(1)
    expect(sides[0]).toMatchObject({
      label: "request retry",
      usage: { input: 10_000, cost: premiumPrices ? 0.08 : 0.075 },
    })
    const restored = subagentsOf(session.id, SessionStore.open(session.file))[0]!
    // Restoration must use billed history, not just the messages in model context.
    expect(restored.messages().filter((m) => m.role === "assistant")).toHaveLength(1)
    for (const usage of [
      result.usage,
      live.info.usage,
      restored.info.usage,
      tree.usage,
      group.info().usage,
    ]) {
      expect(usage.input).toBe(10_100)
      expect(usage.cost).toBeCloseTo(cost, 12)
      expect(usage.pricingUnknown).toBe(premiumPrices ? undefined : true)
      expect(JSON.parse(JSON.stringify(usage))).toEqual(usage)
    }
    expect(restored.info.usage).toEqual(live.info.usage)
    await tree.waitForChildren()
    const replaces = reopened.entries.filter((e) => e.type === "message").map((e) => e.id)
    reopened.append({ type: "compaction", summary: "work completed", replaces })
    const compacted = subagentsOf(session.id, SessionStore.open(session.file))[0]!
    expect(compacted.messages().some((m) => m.role === "assistant" && m.usage?.input === 100)).toBe(false)
    expect(compacted.info.usage).toEqual(live.info.usage)
  })
}

test("BudgetLedger retains estimate markers across confirmed additions and JSON restoration", () => {
  const ledger = new BudgetLedger({ costUsd: 1 })
  const estimate: Usage = { ...emptyUsage(), input: 10_000, cost: 0.08, pricingUnknown: true }
  ledger.add(estimate)
  ledger.add({ ...emptyUsage(), input: 100, cost: 0.00075 })
  expect(ledger.usage.pricingUnknown).toBe(true)
  expect(ledger.usage.cost).toBeCloseTo(0.08075, 12)
  expect(ledger.carve({ costUsd: 1 })?.costUsd).toBeCloseTo(0.91925, 12)
  const restored = new BudgetLedger(undefined)
  restored.add(JSON.parse(JSON.stringify(ledger.usage)))
  restored.add({ ...emptyUsage(), cost: 0.001 })
  expect(restored.usage.pricingUnknown).toBe(true)
  expect(restored.usage.cost).toBeCloseTo(0.08175, 12)
  const confirmed = new BudgetLedger(undefined)
  confirmed.add({ ...emptyUsage(), cost: 0.001 })
  expect(confirmed.usage).not.toHaveProperty("pricingUnknown")
})

test("restored child includes private consultation side usage exactly once", async () => {
  const { parent, tree, session } = setup([
    { toolCalls: [{ name: "private_work", args: {} }], usage: { cost: 0, speed: "standard" } },
    { toolCalls: [{ name: "read", args: {} }], usage: { cost: 1, speed: "standard" } },
    { text: "APPROVE", usage: { cost: 3, speed: "standard" } },
    { text: "private done", usage: { cost: 4, speed: "standard" } },
    { text: "outer done", usage: { cost: 2, speed: "standard" } },
  ])
  parent.tools.register(
    defineTool({
      name: "read",
      description: "read",
      parameters: {},
      execute: async () => textResult("ok"),
    }),
    "test",
  )
  parent.tools.register(
    defineTool({
      name: "private_work",
      description: "private work",
      parameters: {},
      execute: async (_args, ctx) => {
        const child = ctx.session!.spawn!({
          prompt: "private work",
          ephemeral: true,
          callableTools: ["read"],
          maxTurns: 1,
        })
        expect((await child.result()).usage.cost).toBe(8)
        return textResult("ok")
      },
    }),
    "test",
  )
  parent.interceptors.add("tool.call.before", (event) =>
    event.name === "read" ? { action: "ask", reason: "approval needed" } : { action: "pass" },
  )
  const group = tree.createGroup(parent, { name: "outer work" })
  const child = group.spawn({ prompt: "work", callableTools: ["private_work", "read"] })
  const result = await child.result()
  expect(result.status).toBe("done")
  const live = listSubagents(parent, tree)[0]!
  const charges = SessionStore.open(live.file!).entries.filter((e) => e.type === "side_usage")
  expect(charges.map((e) => e.usage.cost)).toEqual([1, 3, 4])
  const restored = subagentsOf(session.id, SessionStore.open(session.file))
  expect(restored).toHaveLength(1)
  expect(live.info.usage.cost).toBe(2)
  expect(restored[0]!.info.usage.cost).toBe(10)
  expect(tree.usage.cost).toBe(10)
  expect(group.info().usage.cost).toBe(10)
})
