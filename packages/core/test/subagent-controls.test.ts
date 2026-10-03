import { afterEach, expect, test } from "bun:test"
import {
  createAi,
  createMockDialect,
  type Message,
  type MockReply,
  type ModelRequest,
  userMessage,
} from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import type { CompactionOptions } from "../src/compaction.ts"
import { EventBus } from "../src/event-bus.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const roots: Agent[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.dispose()))
})

function setup(
  reply: (req: ModelRequest) => MockReply,
  opts: { maxConcurrent?: number; compaction?: CompactionOptions } = {},
) {
  const mock = createMockDialect(Array.from({ length: 30 }, () => reply))
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const tree = new AgentTree({ ai, sections: () => [], ...opts })
  const tools = new ToolRegistry()
  const root = new Agent({ ai, model: ai.model("mock/m"), cwd: process.cwd(), tree, bus, tools })
  roots.push(root)
  return { mock, tree, root, tools, bus, events }
}

async function until(done: () => boolean) {
  const end = Date.now() + 2000
  while (!done()) {
    if (Date.now() > end) throw new Error("condition did not become true")
    await Bun.sleep(1)
  }
}

const textOf = (messages: readonly Message[]) =>
  messages.flatMap((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))).join("\n")

function heldTool(tools: ToolRegistry) {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let aborted = false
  tools.register(
    defineTool({
      name: "hold",
      description: "Wait for the test",
      parameters: { type: "object" },
      execute: async (_args, ctx) => {
        entered.resolve()
        await release.promise
        aborted = ctx.signal.aborted
        return textResult("tool output kept")
      },
    }),
    "test",
  )
  return { entered: entered.promise, release: release.resolve, aborted: () => aborted }
}

for (const persistent of [false, true]) {
  test(`user messages join a running ${persistent ? "persistent" : "ordinary"} child's turn`, async () => {
    let calls = 0
    const { tree, root, tools, mock, bus, events } = setup(() =>
      ++calls === 1 ? { toolCalls: [{ name: "hold", args: {} }] } : { text: "answered" },
    )
    const tool = heldTool(tools)
    const child = tree.spawn(root, { prompt: "work", persistent, ...(persistent ? { maxTurns: 1 } : {}) })
    await tool.entered
    if (!persistent) expect(child.send("extension message")).toBe(false)
    expect(tree.message(child.id, "change direction")).toBe(true)
    expect(tree.message(child.id, "keep the tests")).toBe(true)
    expect(mock.requests).toHaveLength(1)
    tool.release()
    expect((await child.result()).status).toBe("done")
    expect(mock.requests).toHaveLength(2)
    const sent = textOf(mock.requests[1]!.messages)
    expect(sent).toContain("change direction")
    const users = mock.requests[1]!.messages.filter((m) => m.role === "user")
    expect(users.slice(1).flatMap((m) => m.content)).toEqual([
      { type: "text", text: "change direction" },
      { type: "text", text: "keep the tests" },
    ])
    expect(sent.indexOf("change direction")).toBeLessThan(sent.indexOf("keep the tests"))
    await bus.flush()
    const steers = events.filter((e) => e.type === "turn.steer").filter((e) => e.sessionId === child.id)
    expect(steers.filter((e) => e.data.state === "queued")).toHaveLength(2)
    expect(steers.some((e) => e.data.state === "injected")).toBe(true)
    expect(steers.every((e) => e.parentSessionId === root.sessionId)).toBe(true)
    expect(steers[0]!.data.message).toEqual(userMessage("change direction"))
    expect(tool.aborted()).toBe(false)
  })
}

for (const persistent of [false, true]) {
  for (const pause of [false, true]) {
    test(`message during request preparation reaches the next call (persistent=${persistent}, pause=${pause})`, async () => {
      const { tree, root, mock } = setup(() => ({ text: "done" }))
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let builds = 0
      root.interceptors.add("context.build", async (value) => {
        if (++builds === 1) {
          entered.resolve()
          await release.promise
        }
        return { action: "modify", value: { ...value, systemPrompt: "intercepted" } }
      })
      const child = tree.spawn(root, { prompt: "work", persistent, ...(persistent ? { maxTurns: 1 } : {}) })
      await entered.promise
      if (pause) expect(tree.pause(child.id)).toBe(true)
      expect(tree.message(child.id, "before dispatch")).toBe(true)
      if (pause) expect(tree.resume(child.id)).toBe(true)
      release.resolve()
      await child.result()
      expect(textOf(mock.requests[0]!.messages)).toContain("before dispatch")
      expect(mock.requests[0]!.systemPrompt).toBe("intercepted")
      expect(mock.requests).toHaveLength(1)
    })
  }
}

test("persistent user messages signal steering-aware tools without aborting the turn", async () => {
  let calls = 0
  const { tree, root, tools, mock } = setup(() =>
    ++calls === 1 ? { toolCalls: [{ name: "waitForSteer", args: {} }] } : { text: "done" },
  )
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let steered = false
  let aborted = false
  tools.register(
    defineTool({
      name: "waitForSteer",
      description: "Wait for steering",
      parameters: { type: "object" },
      execute: async (_args, ctx) => {
        ctx.steerSignal?.addEventListener(
          "abort",
          () => {
            steered = true
            release.resolve()
          },
          { once: true },
        )
        entered.resolve()
        await release.promise
        aborted = ctx.signal.aborted
        return textResult("partial output")
      },
    }),
    "test",
  )
  const child = tree.spawn(root, { prompt: "work", persistent: true, maxTurns: 1 })
  await entered.promise
  expect(child.send("extension notice")).toBe(true)
  expect(steered).toBe(false)
  expect(tree.message(child.id, "user steering")).toBe(true)
  release.resolve()
  await child.result()
  expect(steered).toBe(true)
  expect(aborted).toBe(false)
  expect(mock.requests).toHaveLength(2)
  expect(textOf(mock.requests[1]!.messages)).toContain("user steering")
  expect(textOf(mock.requests[1]!.messages)).toContain("partial output")
})

test("queued persistent and ordinary messages reach their first admitted model call", async () => {
  const release = Promise.withResolvers<void>()
  const { tree, root, mock, bus, events } = setup(
    () => ({ text: "complete", hold: { chunks: 0, until: release.promise } }),
    { maxConcurrent: 1 },
  )
  const first = tree.spawn(root, { prompt: "first" })
  const queued = tree.spawn(root, { prompt: "queued", persistent: true, maxTurns: 1 })
  const ordinary = tree.spawn(root, { prompt: "ordinary" })
  expect(tree.message(queued.id, "include this")).toBe(true)
  expect(tree.message(first.id, "before startup")).toBe(true)
  expect(tree.message(ordinary.id, "cannot start early")).toBe(true)
  expect(tree.pause(queued.id)).toBe(false)
  expect(tree.resume(queued.id)).toBe(false)
  await until(() => mock.requests.length === 1)
  await bus.flush()
  expect(
    events.some((e) => e.type === "turn.steer" && e.sessionId === queued.id && e.data.state === "queued"),
  ).toBe(true)
  expect(queued.state).toBe("queued")
  expect(mock.requests).toHaveLength(1)
  release.resolve()
  await Promise.all([first.result(), queued.result(), ordinary.result()])
  expect(mock.requests).toHaveLength(3)
  expect(textOf(mock.requests[1]!.messages)).toContain("include this")
  expect(textOf(mock.requests[0]!.messages)).toContain("before startup")
  expect(textOf(mock.requests[2]!.messages)).toContain("cannot start early")
  await bus.flush()
  expect(
    events.some((e) => e.type === "turn.steer" && e.sessionId === ordinary.id && e.data.state === "injected"),
  ).toBe(true)
})

test("a user message wakes an idle persistent child through admission", async () => {
  const release = Promise.withResolvers<void>()
  const { tree, root, mock } = setup(
    (req) => ({
      text: "done",
      ...(textOf(req.messages) === "block" ? { hold: { chunks: 0, until: release.promise } } : {}),
    }),
    { maxConcurrent: 1 },
  )
  const child = tree.spawn(root, { prompt: "first", persistent: true, maxTurns: 2 })
  await until(() => child.state === "idle")
  expect(tree.pause(child.id)).toBe(false)
  expect(tree.resume(child.id)).toBe(false)
  // A paused sibling keeps the only place to run.
  const blocker = tree.spawn(root, { prompt: "block" })
  await until(() => blocker.state === "working")
  expect(tree.pause(blocker.id)).toBe(true)
  expect(tree.message(child.id, "wake up")).toBe(true)
  await until(() => child.state === "queued")
  expect(tree.subagent(child.id)!.info.status).toBe("queued")
  expect(tree.resume(blocker.id)).toBe(true)
  release.resolve()
  await blocker.result()
  expect((await child.result()).turns).toBe(2)
  expect(mock.requests.at(-1)!.messages.at(-1)).toEqual(userMessage("wake up"))
})

for (const persistent of [false, true]) {
  test(`pause during a ${persistent ? "persistent" : "ordinary"} model call retains output and its slot`, async () => {
    const release = Promise.withResolvers<void>()
    const { tree, root, mock, events, bus } = setup(
      () => ({ text: "complete reply", hold: { chunks: 0, until: release.promise } }),
      { maxConcurrent: 1 },
    )
    const child = tree.spawn(root, { prompt: "work", persistent, ...(persistent ? { maxTurns: 1 } : {}) })
    await until(() => mock.requests.length === 1)
    expect(tree.pause(child.id)).toBe(true)
    expect(tree.pause(child.id)).toBe(false)
    expect(tree.subagent(child.id)!.info.status).toBe("paused")
    const queued = tree.spawn(root, { prompt: "next" })
    release.resolve()
    await until(() => tree.subagent(child.id)!.messages?.some((m) => m.role === "assistant") === true)
    await Bun.sleep(10)
    expect(queued.state).toBe("queued")
    expect(mock.requests).toHaveLength(1)
    expect(textOf(tree.subagent(child.id)!.messages!)).toContain("complete reply")
    expect(tree.resume(child.id)).toBe(true)
    expect(tree.resume(child.id)).toBe(false)
    expect((await child.result()).status).toBe("done")
    await queued.result()
    await bus.flush()
    const states = events
      .filter((e) => e.type === "subagent.state")
      .filter((e) => e.data.childSessionId === child.id)
    expect(states.map((e) => e.data.state)).toContain("paused")
    expect(states.at(-1)!.data.state).toBe("working")
    expect(states.every((e) => e.sessionId === root.sessionId)).toBe(true)
  })
}

test("pause lets a running tool finish but holds the next model call and keeps group admission", async () => {
  let calls = 0
  const { tree, root, tools, mock } = setup(() =>
    ++calls === 1 ? { toolCalls: [{ name: "hold", args: {} }] } : { text: "done" },
  )
  const tool = heldTool(tools)
  const group = tree.createGroup(root, { name: "limited", maxConcurrent: 1 })
  const child = group.spawn({ prompt: "work" })
  await tool.entered
  expect(tree.pause(child.id)).toBe(true)
  const queued = group.spawn({ prompt: "wait" })
  expect(tree.message(child.id, "while paused")).toBe(true)
  tool.release()
  await until(() => tree.subagent(child.id)!.messages?.some((m) => m.role === "toolResult") === true)
  await Bun.sleep(10)
  expect(tool.aborted()).toBe(false)
  expect(mock.requests).toHaveLength(1)
  expect(queued.state).toBe("queued")
  expect(group.info().agents).toMatchObject({ working: 1, queued: 1 })
  expect(tree.resume(child.id)).toBe(true)
  expect((await child.result()).status).toBe("done")
  await queued.result()
  expect(textOf(mock.requests[1]!.messages)).toContain("tool output kept")
  expect(textOf(mock.requests[1]!.messages)).toContain("while paused")
})

test("stop unblocks a paused child, admits its successor, and finished/unknown controls return false", async () => {
  const release = Promise.withResolvers<void>()
  const { tree, root, mock } = setup(
    () => ({ text: "complete", hold: { chunks: 0, until: release.promise } }),
    { maxConcurrent: 1 },
  )
  const child = tree.spawn(root, { prompt: "work" })
  await until(() => mock.requests.length === 1)
  expect(tree.pause(child.id)).toBe(true)
  release.resolve()
  await until(() => tree.subagent(child.id)!.messages?.some((m) => m.role === "assistant") === true)
  const next = tree.spawn(root, { prompt: "next" })
  expect(tree.stop(child.id, "stopped by the user")).toBe(true)
  expect(await child.result()).toMatchObject({ status: "aborted", error: "stopped by the user" })
  expect((await next.result()).status).toBe("done")
  for (const id of [child.id, next.id, "unknown"]) {
    expect(tree.message(id, "too late")).toBe(false)
    expect(tree.pause(id)).toBe(false)
    expect(tree.resume(id)).toBe(false)
  }
})

test("a persistent child's clean stop releases a pause without aborting its tool", async () => {
  let calls = 0
  const { tree, root, tools } = setup(() =>
    ++calls === 1 ? { toolCalls: [{ name: "hold", args: {} }] } : { text: "done" },
  )
  const tool = heldTool(tools)
  const child = tree.spawn(root, { prompt: "work", persistent: true })
  await tool.entered
  expect(tree.pause(child.id)).toBe(true)
  child.stop("enough")
  tool.release()
  expect(await child.result()).toMatchObject({ status: "done", note: "enough" })
  expect(tool.aborted()).toBe(false)
})

test("pause holds before compaction and again after an in-flight compaction finishes", async () => {
  const summaryRelease = Promise.withResolvers<void>()
  let calls = 0
  let summarizing = false
  const { tree, root, tools, mock, events } = setup(
    (req) => {
      if (req.systemPrompt.startsWith("You summarize")) {
        summarizing = true
        return { text: "summary kept", hold: { chunks: 0, until: summaryRelease.promise } }
      }
      return ++calls === 1
        ? { toolCalls: [{ name: "hold", args: {} }], usage: { input: 1000 } }
        : { text: "done" }
    },
    { compaction: { threshold: 0.00001, keepTurns: 1 } },
  )
  root.messages.push(userMessage("older work"), {
    role: "assistant",
    content: [{ type: "text", text: "older answer" }],
    model: { provider: "mock", model: "m" },
  })
  const tool = heldTool(tools)
  const child = tree.spawn(root, { prompt: "continue", context: "fork" })
  await tool.entered
  expect(tree.pause(child.id)).toBe(true)
  tool.release()
  await until(() => tree.subagent(child.id)!.messages?.some((m) => m.role === "toolResult") === true)
  await Bun.sleep(10)
  expect(summarizing).toBe(false)
  expect(tree.resume(child.id)).toBe(true)
  await until(() => summarizing)
  expect(tree.pause(child.id)).toBe(true)
  expect(tree.message(child.id, "keep this after summary")).toBe(true)
  summaryRelease.resolve()
  await until(() => events.some((e) => e.type === "compact.end"))
  await Bun.sleep(10)
  expect(mock.requests).toHaveLength(2)
  expect(tree.subagent(child.id)!.info.status).toBe("paused")
  expect(tree.resume(child.id)).toBe(true)
  expect((await child.result()).status).toBe("done")
  expect(textOf(mock.requests[2]!.messages)).toContain("summary kept")
  expect(textOf(mock.requests[2]!.messages)).toContain("keep this after summary")
})
