import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, emptyUsage } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), "amira-budget-pricing-"))
  const ai = createAi({
    dialects: [createMockDialect([{ text: "done", usage: { input: 100, cost: 2, speed: "fast" } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const tree = new AgentTree({ ai, sections: () => [], budget: { costUsd: 10 } })
  const root = new Agent({ ai, model: ai.model("mock/m"), bus, tree, cwd: home, systemPrompt: "" })
  cleanups.push(async () => {
    tree.abortAll("test cleanup")
    await root.dispose()
    await tree.waitForChildren()
    rmSync(home, { recursive: true, force: true })
  })
  return { tree, root, bus, events }
}

test("budget exhaustion stays latched after a correction and blocks another main request", async () => {
  const { tree, root } = setup()
  expect(tree.budgetExceeded).toBeUndefined()
  tree.recordUsage(root, { ...emptyUsage(), cost: 11 })
  expect(tree.budgetExceeded).toBe("$11.0000 spent, limit $10")
  tree.recordUsage(root, { ...emptyUsage(), cost: -11 })
  expect(tree.usage.cost).toBe(0)
  expect(tree.budgetExceeded).toBe("$11.0000 spent, limit $10")
  expect(await root.prompt("must not call the model")).toEqual({ reason: "aborted", steps: 0 })
  expect(root.messages.filter((message) => message.role === "assistant")).toHaveLength(0)
})

test("budget.update propagates estimates from group children without changing confirmed amounts", async () => {
  const { tree, root, bus, events } = setup()
  tree.recordUsage(root, { ...emptyUsage(), input: 10, cost: 1 })
  await bus.flush()
  expect(events.findLast((event) => event.type === "budget.update")?.data).toEqual({
    tokens: 10,
    costUsd: 1,
    limit: { costUsd: 10 },
  })
  const group = tree.createGroup(root, { name: "work" })
  await group.spawn({ prompt: "work" }).result()
  tree.recordUsage(root, { ...emptyUsage(), input: 10, cost: 1 })
  await bus.flush()
  expect(events.findLast((event) => event.type === "budget.update")?.data).toMatchObject({
    costUsd: 4,
    pricingUnknown: true,
    limit: { costUsd: 10 },
  })
  const update = events.findLast((event) => event.type === "group.update")
  expect(update?.data).toMatchObject({ group: { usage: { cost: 2, pricingUnknown: true } } })
  expect(group.info().usage).toMatchObject({ cost: 2, pricingUnknown: true })
})
