import { afterEach, expect, test } from "bun:test"
import { type Ai, createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const promptOf = (req: ModelRequest) => req.messages.find((m) => m.role === "user")?.content[0]

async function fixture(options: { persistent?: boolean; paused?: boolean; deep?: boolean } = {}) {
  const entered = Promise.withResolvers<void>()
  const secondEntered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<void>()
  const requests: string[] = []
  const mock = createMockDialect(
    Array.from({ length: 10 }, () => (req: ModelRequest) => {
      const prompt = promptOf(req)
      return {
        toolCalls: [
          { name: prompt?.type === "text" && prompt.text === "parent" ? "launch" : "hold", args: {} },
        ],
      }
    }),
  )
  const base = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const ai: Ai = {
    ...base,
    async *stream(req, signal) {
      const first = promptOf(req)
      const prompt = first?.type === "text" ? first.text : ""
      requests.push(prompt)
      if (prompt === "parent" && req.messages.at(-1)?.role === "toolResult") {
        yield {
          type: "error",
          error: { kind: "network", code: "proxy_broker_lost", message: "broker lost" },
          retryable: false,
          message: {
            role: "assistant",
            model: { provider: "mock", model: "m" },
            content: [{ type: "text", text: "parent partial" }],
            stopReason: "error",
          },
        }
        failed.resolve()
      } else yield* base.stream(req, signal)
    },
  }
  const tree = new AgentTree({ ai, sections: () => [], maxConcurrent: 3, maxDepth: 3 })
  const tools = new ToolRegistry()
  const root = new Agent({ ai, tree, tools, cwd: process.cwd(), model: ai.model("mock/m") })
  let descendant!: ChildSession
  let leaf: ChildSession | undefined
  let toolSignal!: AbortSignal
  const toolSignals: AbortSignal[] = []
  tools.register(
    defineTool({
      name: "launch",
      description: "",
      parameters: {},
      execute: async (_args, ctx) => {
        descendant = ctx.session!.createGroup!({ name: "nested" }).spawn({
          prompt: "descendant",
          persistent: options.persistent,
        })
        await entered.promise
        if (options.deep) {
          if (!(descendant instanceof Child)) throw new Error("expected live child")
          leaf = tree.spawn(descendant.agent, { prompt: "leaf" })
          await secondEntered.promise
        }
        if (options.paused) {
          if (!(descendant instanceof Child)) throw new Error("expected live child")
          expect(descendant.pause()).toBe(true)
        }
        return textResult("launched")
      },
    }),
    "test",
  )
  tools.register(
    defineTool({
      name: "hold",
      description: "",
      parameters: {},
      execute: async (_args, ctx) => {
        toolSignal = ctx.signal
        toolSignals.push(ctx.signal)
        entered.resolve()
        if (toolSignals.length === 2) secondEntered.resolve()
        await release.promise
        return textResult("saved tool output")
      },
    }),
    "test",
  )
  cleanup.push(async () => {
    release.resolve()
    await root.dispose()
  })
  const parent = tree.spawn(root, { prompt: "parent" })
  await failed.promise
  // Let turn finalization reach teardown without using wall-clock reconnect timers.
  for (let i = 0; i < 100; i++) await Promise.resolve()
  return { tree, root, parent, descendant, leaf, toolSignal, toolSignals, release, requests }
}

test("a network-ended child drains descendants' running tools and closes model admission", async () => {
  const { parent, descendant, toolSignal, release, requests, tree } = await fixture()
  expect(toolSignal.aborted).toBe(false)
  let ended = false
  void parent.result().then(() => {
    ended = true
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(ended).toBe(false)
  if (!(descendant instanceof Child)) throw new Error("expected live child")
  expect(() => tree.spawn(descendant.agent, { prompt: "too late" })).toThrow(/ended/)
  release.resolve()
  expect(await parent.result()).toMatchObject({
    status: "error",
    text: "parent partial",
    error: "broker lost",
  })
  await tree.waitForChildren()
  expect(toolSignal.aborted).toBe(false)
  expect(requests).toEqual(["parent", "descendant", "parent"])
  expect(descendant.agent.messages.find((m) => m.role === "toolResult")).toMatchObject({
    content: [{ type: "text", text: "saved tool output" }],
  })
})

test("network teardown drains multiple generations before closing any failed subtree", async () => {
  const { parent, descendant, leaf, toolSignals, release, requests, tree } = await fixture({ deep: true })
  expect(toolSignals).toHaveLength(2)
  expect(toolSignals.every((signal) => !signal.aborted)).toBe(true)
  release.resolve()
  expect((await parent.result()).status).toBe("error")
  expect((await descendant.result()).status).toBe("error")
  expect((await leaf!.result()).status).toBe("error")
  await tree.waitForChildren()
  expect(toolSignals.every((signal) => !signal.aborted)).toBe(true)
  expect(requests).toEqual(["parent", "descendant", "leaf", "parent"])
})

test("paused persistent descendants finish their tool batch without reopening model admission", async () => {
  const { parent, descendant, toolSignal, release, requests, tree } = await fixture({
    persistent: true,
    paused: true,
  })
  expect(toolSignal.aborted).toBe(false)
  release.resolve()
  expect((await parent.result()).status).toBe("error")
  expect((await descendant.result()).status).toBe("error")
  await tree.waitForChildren()
  expect(toolSignal.aborted).toBe(false)
  expect(requests).toEqual(["parent", "descendant", "parent"])
})

test("explicit abort during a network drain still interrupts descendant tools immediately", async () => {
  const { parent, descendant, toolSignal, release, tree } = await fixture()
  expect(toolSignal.aborted).toBe(false)
  parent.abort("user stopped")
  expect(toolSignal.aborted).toBe(true)
  release.resolve()
  expect((await parent.result()).status).toBe("aborted")
  expect((await descendant.result()).status).toBe("aborted")
  await tree.waitForChildren()
})
