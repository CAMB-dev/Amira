import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

const promptOf = (request: ModelRequest) => {
  const content = request.messages.at(-1)?.content[0]
  return content?.type === "text" ? content.text : ""
}

async function until(done: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("expected admission state was not reached")
    await Bun.sleep(2)
  }
}

async function setup(
  reply: (request: ModelRequest) => MockReply,
  maxConcurrent = 1,
  replies = 30,
  streamCleanup?: (request: ModelRequest) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-nested-admission-"))
  const mock = createMockDialect(Array.from({ length: replies }, () => reply))
  let active = 0
  let peak = 0
  const stream = mock.stream.bind(mock)
  // Count actual model streams, including parents re-entering while descendants are live.
  mock.stream = async function* (request, context) {
    active++
    peak = Math.max(peak, active)
    try {
      yield* stream(request, context)
    } finally {
      await streamCleanup?.(request)
      active--
    }
  }
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, maxConcurrent, maxDepth: 3, sections: () => [] })
  const tools = new ToolRegistry()
  const root = new Agent({ ai, tree, tools, cwd: dir, model: ai.model("mock/m"), bus: new EventBus() })
  cleanup.push(async () => {
    await root.dispose()
    expect(active).toBe(0)
    await rm(dir, { recursive: true, force: true })
  })
  return { root, tree, tools, mock, active: () => active, peak: () => peak }
}

test("an idle live nested child does not free its parent's running follow-up slot", async () => {
  const gates = new Map<string, () => void>()
  const { root, tree, tools, mock, active, peak } = await setup((request) => {
    const prompt = promptOf(request)
    if (prompt === "L-initial") return { toolCalls: [{ name: "inner", args: {} }] }
    if (prompt === "L-follow" || prompt === "S") {
      const until = new Promise<void>((resolve) => gates.set(prompt, resolve))
      return { text: "held", hold: { chunks: 0, until } }
    }
    return { text: "ready" }
  })
  cleanup.unshift(async () => {
    for (const release of gates.values()) release()
  })
  let nested!: ChildSession
  tools.register(
    defineTool({
      name: "inner",
      description: "Create an idle nested child",
      parameters: { type: "object" },
      execute: async (_args, ctx) => {
        const inner = ctx.session!.createGroup!({ name: "inner", maxConcurrent: 1 })
        nested = inner.spawn({ prompt: "C", ephemeral: true })
        await until(() => nested.state === "idle")
        return textResult("child left idle and live")
      },
    }),
    "test",
  )
  const outer = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
  const parent = outer.spawn({ prompt: "L-initial", ephemeral: true })
  await until(() => parent.state === "idle")
  expect(nested.state).toBe("idle")
  expect(active()).toBe(0)
  expect(parent.send("L-follow")).toBe(true)
  await until(() => gates.has("L-follow"))
  expect(active()).toBe(1)
  const sibling = outer.spawn({ prompt: "S", ephemeral: true, maxTurns: 1 })
  await Bun.sleep(20)
  expect(active()).toBe(1)
  expect(peak()).toBe(1)
  expect(sibling.state).toBe("queued")
  expect(mock.requests.map(promptOf)).not.toContain("S")
  gates.get("L-follow")!()
  await until(() => gates.has("S"))
  expect(nested.state).toBe("idle")
  gates.get("S")!()
  expect((await sibling.result()).status).toBe("done")
  expect(peak()).toBe(1)
})

for (const [treeCap, groupCap] of [
  [1, 3],
  [3, 1],
] as const) {
  test(`ancestor re-entry obeys tree ${treeCap} and group ${groupCap} with a streaming child`, async () => {
    const gates = new Map<string, () => void>()
    const returnTool = Promise.withResolvers<void>()
    const { root, tree, tools, mock, active, peak } = await setup((request) => {
      const prompt = promptOf(request)
      if (prompt === "parent") return { toolCalls: [{ name: "launch", args: {} }] }
      if (prompt === "nested" || request.messages.at(-1)?.role === "toolResult") {
        const key = prompt === "nested" ? "nested" : "parent re-entry"
        const until = new Promise<void>((resolve) => gates.set(key, resolve))
        return { text: "held", hold: { chunks: 0, until } }
      }
      return { text: "ready" }
    }, treeCap)
    cleanup.unshift(async () => {
      returnTool.resolve()
      for (const release of gates.values()) release()
    })
    let nested!: ChildSession
    tools.register(
      defineTool({
        name: "launch",
        description: "Launch a descendant and return before it finishes",
        parameters: { type: "object" },
        execute: async (_args, ctx) => {
          const inner = ctx.session!.createGroup!({ name: "inner", maxConcurrent: 1 })
          nested = inner.spawn({ prompt: "nested", ephemeral: true, maxTurns: 1 })
          await returnTool.promise
          return textResult("descendant still running")
        },
      }),
      "test",
    )
    const outer = tree.createGroup(root, { name: "outer", maxConcurrent: groupCap })
    const parent = outer.spawn({ prompt: "parent", ephemeral: true, maxTurns: 1 })
    await until(() => gates.has("nested"))
    expect(active()).toBe(1)
    returnTool.resolve()
    await Bun.sleep(20)
    expect(nested.state).toBe("working")
    expect(gates.has("parent re-entry")).toBe(false)
    expect(mock.requests).toHaveLength(2)
    expect(active()).toBe(1)
    expect(peak()).toBe(1)
    gates.get("nested")!()
    expect((await nested.result()).status).toBe("done")
    await until(() => gates.has("parent re-entry"))
    gates.get("parent re-entry")!()
    expect((await parent.result()).status).toBe("done")
    expect(peak()).toBe(1)
  })
}

for (const delivery of ["send", "notice"] as const) {
  test(`a persistent ancestor ${delivery} wake queues behind a running nested follow-up`, async () => {
    const gates = new Map<string, () => void>()
    const { root, tree, tools, mock, active, peak } = await setup((request) => {
      const prompt = promptOf(request)
      if (prompt === "parent") return { toolCalls: [{ name: "launch", args: {} }] }
      if (prompt === "nested follow-up" || prompt === "parent follow-up") {
        const until = new Promise<void>((resolve) => gates.set(prompt, resolve))
        return { text: "held", hold: { chunks: 0, until } }
      }
      return { text: "ready" }
    })
    cleanup.unshift(async () => {
      for (const release of gates.values()) release()
    })
    let nested!: ChildSession
    tools.register(
      defineTool({
        name: "launch",
        description: "Keep an idle persistent descendant",
        parameters: { type: "object" },
        execute: async (_args, ctx) => {
          const inner = ctx.session!.createGroup!({ name: "inner", maxConcurrent: 1 })
          nested = inner.spawn({ prompt: "nested", ephemeral: true })
          await until(() => nested.state === "idle")
          return textResult("descendant ready")
        },
      }),
      "test",
    )
    const outer = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
    const parent = outer.spawn({ prompt: "parent", ephemeral: true })
    await until(() => parent.state === "idle")
    expect(nested.send("nested follow-up")).toBe(true)
    await until(() => gates.has("nested follow-up"))
    if (delivery === "send") expect(parent.send("parent follow-up")).toBe(true)
    else
      parent.expectNotice().deliver({
        role: "user",
        content: [{ type: "text", text: "parent follow-up" }],
      })
    await until(() => parent.state === "queued")
    await Bun.sleep(20)
    expect(gates.has("parent follow-up")).toBe(false)
    expect(mock.requests.map(promptOf)).not.toContain("parent follow-up")
    expect(active()).toBe(1)
    gates.get("nested follow-up")!()
    await until(() => gates.has("parent follow-up"))
    expect(nested.state).toBe("idle")
    gates.get("parent follow-up")!()
    await until(() => parent.state === "idle")
    expect(peak()).toBe(1)
  })
}

test("multiple ancestors reacquire in FIFO order without overlapping their running leaf", async () => {
  const gates = new Map<string, () => void>()
  const returnMiddle = Promise.withResolvers<void>()
  const returnLeaf = Promise.withResolvers<void>()
  const { root, tree, tools, active, peak } = await setup((request) => {
    const prompt = promptOf(request)
    if (prompt === "parent") return { toolCalls: [{ name: "middle", args: {} }] }
    if (prompt === "middle") return { toolCalls: [{ name: "leaf", args: {} }] }
    const key = request.messages.at(-1)?.role === "toolResult" ? prompt : "leaf stream"
    const until = new Promise<void>((resolve) => gates.set(key, resolve))
    return { text: "held", hold: { chunks: 0, until } }
  })
  cleanup.unshift(async () => {
    returnMiddle.resolve()
    returnLeaf.resolve()
    for (const release of gates.values()) release()
  })
  let middle!: ChildSession
  let leaf!: ChildSession
  for (const [name, returned] of [
    ["middle", returnMiddle],
    ["leaf", returnLeaf],
  ] as const) {
    tools.register(
      defineTool({
        name,
        description: "Launch a descendant and return before it finishes",
        parameters: { type: "object" },
        execute: async (_args, ctx) => {
          const inner = ctx.session!.createGroup!({ name, maxConcurrent: 1 })
          const child = inner.spawn({
            prompt: name,
            ephemeral: true,
            ...(name === "leaf" ? { maxTurns: 1 } : {}),
          })
          if (name === "middle") middle = child
          else leaf = child
          await returned.promise
          return textResult(`${name} still running`)
        },
      }),
      "test",
    )
  }
  const outer = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
  const parent = outer.spawn({ prompt: "parent", ephemeral: true })
  await until(() => gates.has("leaf stream"))
  returnMiddle.resolve()
  await Bun.sleep(10)
  returnLeaf.resolve()
  await Bun.sleep(20)
  expect(gates.has("middle still running")).toBe(false)
  expect(gates.has("leaf still running")).toBe(false)
  expect(active()).toBe(1)
  gates.get("leaf stream")!()
  expect((await leaf.result()).status).toBe("done")
  await until(() => gates.has("middle still running"))
  expect(gates.has("leaf still running")).toBe(false)
  gates.get("middle still running")!()
  await until(() => gates.has("leaf still running"))
  expect(parent.state).toBe("idle")
  gates.get("leaf still running")!()
  await until(() => middle.state === "idle")
  expect(peak()).toBe(1)
})

test("aborting queued ancestor re-entry cancels the wait and frees later admission", async () => {
  const leafHeld = Promise.withResolvers<void>()
  const returnTool = Promise.withResolvers<void>()
  const { root, tree, tools, mock, peak } = await setup((request) => {
    const prompt = promptOf(request)
    if (prompt === "parent") return { toolCalls: [{ name: "launch", args: {} }] }
    if (prompt === "leaf") return { text: "held", hold: { chunks: 0, until: leafHeld.promise } }
    return { text: "done" }
  })
  cleanup.unshift(async () => {
    returnTool.resolve()
    leafHeld.resolve()
  })
  let leaf!: ChildSession
  tools.register(
    defineTool({
      name: "launch",
      description: "Return while a descendant is running",
      parameters: { type: "object" },
      execute: async (_args, ctx) => {
        leaf = ctx.session!.spawn!({ prompt: "leaf", ephemeral: true, maxTurns: 1 })
        await returnTool.promise
        return textResult("leaf still running")
      },
    }),
    "test",
  )
  const parent = tree.spawn(root, { prompt: "parent", ephemeral: true, maxTurns: 1 })
  await until(() => mock.requests.some((request) => promptOf(request) === "leaf"))
  returnTool.resolve()
  await Bun.sleep(20)
  expect(mock.requests).toHaveLength(2)
  parent.abort("cancel re-entry")
  expect((await parent.result()).status).toBe("aborted")
  leafHeld.resolve()
  expect((await leaf.result()).status).toBe("aborted")
  const next = tree.spawn(root, { prompt: "next", ephemeral: true, maxTurns: 1 })
  expect((await next.result()).status).toBe("done")
  expect(mock.requests.map(promptOf)).toEqual(["parent", "leaf", "next"])
  expect(peak()).toBe(1)
})

test("a parent ending at tools needs no slot held by its live descendant", async () => {
  const leafHeld = Promise.withResolvers<void>()
  const { root, tree, tools, mock, peak } = await setup((request) => {
    if (promptOf(request) === "parent") {
      return {
        toolCalls: [
          { name: "launch", args: {} },
          { name: "return_result", args: { value: "done" } },
        ],
      }
    }
    return { text: "held", hold: { chunks: 0, until: leafHeld.promise } }
  })
  cleanup.unshift(async () => leafHeld.resolve())
  tools.register(
    defineTool({
      name: "launch",
      description: "Launch a descendant without waiting for it",
      parameters: { type: "object" },
      execute: async (_args, ctx) => {
        ctx.session!.spawn!({ prompt: "leaf", ephemeral: true, maxTurns: 1 })
        await until(() => mock.requests.length === 2)
        return textResult("leaf still running")
      },
    }),
    "test",
  )
  const parent = tree.spawn(root, { prompt: "parent", schema: { type: "string" } })
  await until(() => parent.state === "ended")
  const result = await parent.result()
  expect(result.status).toBe("done")
  expect(result.value).toBe("done")
  expect(mock.requests).toHaveLength(2)
  expect(peak()).toBe(1)
})

test("a parent at its model step limit ends without reacquiring its held descendant's slot", async () => {
  const leafHeld = Promise.withResolvers<void>()
  let parentCalls = 0
  const { root, tree, tools, mock, active, peak } = await setup(
    (request) => {
      if (promptOf(request) === "leaf") return { text: "held", hold: { chunks: 0, until: leafHeld.promise } }
      parentCalls++
      return { toolCalls: [{ name: parentCalls === 500 ? "launch" : "noop", args: {} }] }
    },
    1,
    501,
  )
  cleanup.unshift(async () => leafHeld.resolve())
  let leaf!: ChildSession
  for (const name of ["noop", "launch"]) {
    tools.register(
      defineTool({
        name,
        description: "Exercise the last allowed model call",
        parameters: { type: "object" },
        execute: async (_args, ctx) => {
          if (name === "launch") {
            leaf = ctx.session!.spawn!({ prompt: "leaf", ephemeral: true, maxTurns: 1 })
            await until(() => active() === 1 && mock.requests.length === 501)
          }
          return textResult("ok")
        },
      }),
      "test",
    )
  }
  const parent = tree.spawn(root, { prompt: "parent", ephemeral: true, maxTurns: 1 })
  await until(() => mock.requests.length === 501)
  await Bun.sleep(20)
  expect(parentCalls).toBe(500)
  expect(parent.state).toBe("ended")
  const result = await parent.result()
  expect(result.status).toBe("error")
  expect(result.error).toBe("stopped after 500 model calls")
  expect(result.steps).toBe(500)
  expect(active()).toBe(1)
  leafHeld.resolve()
  expect((await leaf.result()).status).toBe("aborted")
  expect(mock.requests).toHaveLength(501)
  expect(peak()).toBe(1)
})

for (const [treeCap, groupCap] of [
  [1, 3],
  [3, 1],
] as const) {
  test(`idle descendants do not yield a local approval consultation at tree ${treeCap} group ${groupCap}`, async () => {
    const gates = new Map<string, () => void>()
    const { root, tree, tools, mock, active, peak } = await setup((request) => {
      const prompt = promptOf(request)
      if (prompt === "L-initial") return { toolCalls: [{ name: "inner", args: {} }] }
      if (prompt === "L-follow") return { toolCalls: [{ name: "read", args: {} }] }
      if (prompt.includes('wants to call the tool "read"') || prompt === "S") {
        const key = prompt === "S" ? "S" : "approval"
        const until = new Promise<void>((resolve) => gates.set(key, resolve))
        return { text: "APPROVE", hold: { chunks: 0, until } }
      }
      return { text: "ready" }
    }, treeCap)
    cleanup.unshift(async () => {
      for (const release of gates.values()) release()
    })
    root.interceptors.add("tool.call.before", (event) =>
      event.name === "read" ? { action: "ask", reason: "approval required" } : { action: "pass" },
    )
    let nested!: ChildSession
    tools.register(
      defineTool({
        name: "inner",
        description: "Leave an idle descendant",
        parameters: { type: "object" },
        execute: async (_args, ctx) => {
          nested = ctx.session!.spawn!({ prompt: "C", ephemeral: true })
          await until(() => nested.state === "idle")
          return textResult("idle descendant")
        },
      }),
      "test",
    )
    tools.register(
      defineTool({
        name: "read",
        description: "Require approval",
        parameters: { type: "object" },
        execute: async () => textResult("read"),
      }),
      "test",
    )
    const outer = tree.createGroup(root, { name: "outer", maxConcurrent: groupCap })
    const parent = outer.spawn({ prompt: "L-initial", ephemeral: true })
    await until(() => parent.state === "idle")
    expect(nested.state).toBe("idle")
    expect(parent.send("L-follow")).toBe(true)
    await until(() => gates.has("approval"))
    expect(active()).toBe(1)
    const sibling = outer.spawn({ prompt: "S", ephemeral: true, maxTurns: 1 })
    await Bun.sleep(20)
    expect(active()).toBe(1)
    expect(peak()).toBe(1)
    expect(sibling.state).toBe("queued")
    expect(mock.requests.map(promptOf)).not.toContain("S")
    gates.get("approval")!()
    await until(() => gates.has("S"))
    gates.get("S")!()
    expect((await sibling.result()).status).toBe("done")
    await until(() => parent.state === "idle")
    expect(nested.state).toBe("idle")
    expect(peak()).toBe(1)
  })
}

for (const [treeCap, groupCap] of [
  [1, 3],
  [3, 1],
] as const) {
  for (const cancel of [false, true]) {
    test(`parallel launch and approval ${cancel ? "cancels its permit wait" : "obey actual stream cap"} at tree ${treeCap} group ${groupCap}`, async () => {
      const leafHeld = Promise.withResolvers<void>()
      const approvalHeld = Promise.withResolvers<void>()
      const leafStarted = Promise.withResolvers<void>()
      let asked = false
      let consulting = false
      const { root, tree, tools, mock, active, peak } = await setup((request) => {
        const prompt = promptOf(request)
        if (prompt === "L")
          return {
            toolCalls: [
              { name: "launch", args: {} },
              { name: "read", args: {} },
            ],
          }
        if (prompt === "C") {
          leafStarted.resolve()
          return { text: "leaf done", hold: { chunks: 0, until: leafHeld.promise } }
        }
        if (prompt.includes('wants to call the tool "read"')) {
          consulting = true
          return { text: "APPROVE", hold: { chunks: 0, until: approvalHeld.promise } }
        }
        return { text: "done" }
      }, treeCap)
      cleanup.unshift(async () => {
        leafHeld.resolve()
        approvalHeld.resolve()
      })
      root.interceptors.add("tool.call.before", async (event) => {
        if (event.name !== "read") return { action: "pass" }
        await leafStarted.promise
        asked = true
        return { action: "ask", reason: "approval required" }
      })
      let leaf!: ChildSession
      for (const name of ["launch", "read"]) {
        tools.register(
          defineTool({
            name,
            description: name,
            parameters: { type: "object" },
            concurrency: "parallel",
            execute: async (_args, ctx) => {
              if (name === "launch") {
                leaf = ctx.session!.spawn!({ prompt: "C", ephemeral: true, maxTurns: 1 })
                await leaf.result()
              }
              return textResult("ok")
            },
          }),
          "test",
        )
      }
      const group = tree.createGroup(root, { name: "outer", maxConcurrent: groupCap })
      const parent = group.spawn({ prompt: "L", ephemeral: true, maxTurns: 1 })
      await until(() => asked)
      await Bun.sleep(20)
      expect(active()).toBe(1)
      expect(peak()).toBe(1)
      expect(consulting).toBe(false)
      expect(mock.requests).toHaveLength(2)
      if (cancel) {
        const next = group.spawn({ prompt: "next", ephemeral: true, maxTurns: 1 })
        expect(next.state).toBe("queued")
        parent.abort("cancel consultation permit wait")
        expect((await parent.result()).status).toBe("aborted")
        leafHeld.resolve()
        expect((await leaf.result()).status).toBe("aborted")
        expect((await next.result()).status).toBe("done")
        expect(consulting).toBe(false)
        expect(mock.requests.map(promptOf)).toEqual(["L", "C", "next"])
        expect(peak()).toBe(1)
        return
      }
      leafHeld.resolve()
      expect((await leaf.result()).status).toBe("done")
      await until(() => consulting)
      expect(active()).toBe(1)
      approvalHeld.resolve()
      expect((await parent.result()).status).toBe("done")
      expect(mock.requests).toHaveLength(4)
      expect(peak()).toBe(1)
    })
  }
}

for (const [treeCap, groupCap] of [
  [1, 3],
  [3, 1],
] as const) {
  for (const descendant of ["spawn", "follow-up"] as const) {
    test(`a descendant ${descendant} during consultation cannot yield its stream at tree ${treeCap} group ${groupCap}`, async () => {
      const approvalStarted = Promise.withResolvers<void>()
      const approvalHeld = Promise.withResolvers<void>()
      const leafHeld = Promise.withResolvers<void>()
      let consulting = false
      let leafStreaming = false
      const { root, tree, tools, active, peak } = await setup((request) => {
        const prompt = promptOf(request)
        if (prompt === "initial") return { toolCalls: [{ name: "initial", args: {} }] }
        if (prompt === "L")
          return {
            toolCalls: [
              { name: "launch", args: {} },
              { name: "read", args: {} },
            ],
          }
        if (prompt === "C") {
          leafStreaming = true
          return { text: "done", hold: { chunks: 0, until: leafHeld.promise } }
        }
        if (prompt.includes('wants to call the tool "read"')) {
          consulting = true
          approvalStarted.resolve()
          return { text: "APPROVE", hold: { chunks: 0, until: approvalHeld.promise } }
        }
        return { text: "done" }
      }, treeCap)
      cleanup.unshift(async () => {
        approvalStarted.resolve()
        approvalHeld.resolve()
        leafHeld.resolve()
      })
      root.interceptors.add("tool.call.before", (event) =>
        event.name === "read" ? { action: "ask", reason: "approval required" } : { action: "pass" },
      )
      let leaf!: ChildSession
      for (const name of ["initial", "launch", "read"]) {
        tools.register(
          defineTool({
            name,
            description: name,
            parameters: { type: "object" },
            concurrency: "parallel",
            execute: async (_args, ctx) => {
              if (name === "initial") {
                leaf = ctx.session!.spawn!({ prompt: "idle", ephemeral: true })
                await until(() => leaf.state === "idle")
              }
              if (name === "launch") {
                await approvalStarted.promise
                if (descendant === "spawn")
                  leaf = ctx.session!.spawn!({ prompt: "C", ephemeral: true, maxTurns: 1 })
                else expect(leaf.send("C")).toBe(true)
                await until(() => (descendant === "spawn" ? leaf.state === "ended" : leaf.state === "idle"))
              }
              return textResult("ok")
            },
          }),
          "test",
        )
      }
      const group = tree.createGroup(root, { name: "outer", maxConcurrent: groupCap })
      const parent = group.spawn({
        prompt: descendant === "spawn" ? "L" : "initial",
        ephemeral: true,
        ...(descendant === "spawn" ? { maxTurns: 1 } : {}),
      })
      if (descendant === "follow-up") {
        await until(() => parent.state === "idle")
        expect(parent.send("L")).toBe(true)
      }
      await until(() => consulting && leaf?.state === "queued")
      await Bun.sleep(20)
      expect(active()).toBe(1)
      expect(peak()).toBe(1)
      expect(leafStreaming).toBe(false)
      approvalHeld.resolve()
      await until(() => leafStreaming)
      expect(active()).toBe(1)
      leafHeld.resolve()
      if (descendant === "spawn") expect((await parent.result()).status).toBe("done")
      else await until(() => parent.state === "idle")
      expect(peak()).toBe(1)
    })
  }
}

for (const [treeCap, groupCap] of [
  [1, 3],
  [3, 1],
] as const) {
  test(`an ended requester retains its delayed consultation stream at tree ${treeCap} group ${groupCap}`, async () => {
    const cleanupReady = Promise.withResolvers<void>()
    const cleanupHeld = Promise.withResolvers<void>()
    let consulting = false
    const { root, tree, tools, mock, active, peak } = await setup(
      (request) => {
        const prompt = promptOf(request)
        if (prompt === "L") return { toolCalls: [{ name: "read", args: {} }] }
        if (prompt.includes('wants to call the tool "read"')) {
          consulting = true
          return { text: "APPROVE", usage: { cost: 3 }, delayMs: 10_000 }
        }
        return { text: "done" }
      },
      treeCap,
      30,
      async (request) => {
        if (!promptOf(request).includes('wants to call the tool "read"')) return
        cleanupReady.resolve()
        await cleanupHeld.promise
      },
    )
    cleanup.unshift(async () => {
      cleanupHeld.resolve()
    })
    root.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval required" }))
    tools.register(
      defineTool({
        name: "read",
        description: "read",
        parameters: { type: "object" },
        execute: async () => textResult("ok"),
      }),
      "test",
    )
    const group = tree.createGroup(root, { name: "outer", maxConcurrent: groupCap })
    const parent = group.spawn({ prompt: "L", ephemeral: true, maxTurns: 1 })
    await until(() => consulting)
    const sibling = group.spawn({ prompt: "S", ephemeral: true, maxTurns: 1 })
    expect(sibling.state).toBe("queued")
    parent.abort("abort during consultation")
    await cleanupReady.promise
    expect((await parent.result()).status).toBe("aborted")
    expect(group.info().agents.ended).toBe(1)
    expect(group.info().agents.queued).toBe(1)
    expect(active()).toBe(1)
    await Bun.sleep(20)
    expect(sibling.state).toBe("queued")
    expect(mock.requests).toHaveLength(2)
    expect(active()).toBe(1)
    expect(peak()).toBe(1)
    cleanupHeld.resolve()
    expect((await sibling.result()).status).toBe("done")
    expect(active()).toBe(0)
    expect(mock.requests.map(promptOf).at(-1)).toBe("S")
    expect(tree.usage.cost).toBe(3)
    expect(group.info().usage.cost).toBe(3)
    expect(peak()).toBe(1)
  })
}

for (const wake of ["before tools", "inside tools"] as const) {
  test(`an existing descendant waking ${wake} still borrows its tool-waiting parent's slot`, async () => {
    const gates = new Map<string, () => void>()
    const parentModel = Promise.withResolvers<void>()
    const { root, tree, tools, active, peak } = await setup((request) => {
      const prompt = promptOf(request)
      if (prompt === "parent") return { toolCalls: [{ name: "launch", args: {} }] }
      if (prompt === "parent follow-up")
        return {
          text: "waiting",
          toolCalls: [{ name: "wait", args: {} }],
          ...(wake === "before tools" ? { hold: { chunks: 0, until: parentModel.promise } } : {}),
        }
      if (prompt === "nested follow-up" || prompt === "sibling") {
        const until = new Promise<void>((resolve) => gates.set(prompt, resolve))
        return { text: "held", hold: { chunks: 0, until } }
      }
      return { text: "ready" }
    })
    cleanup.unshift(async () => {
      parentModel.resolve()
      for (const release of gates.values()) release()
    })
    let nested!: ChildSession
    for (const name of ["launch", "wait"]) {
      tools.register(
        defineTool({
          name,
          description: "Wait for a descendant's turn",
          parameters: { type: "object" },
          execute: async (_args, ctx) => {
            if (name === "launch") nested = ctx.session!.spawn!({ prompt: "nested", ephemeral: true })
            else {
              if (wake === "inside tools") expect(nested.send("nested follow-up")).toBe(true)
              await until(() => gates.has("nested follow-up"))
            }
            await until(() => nested.state === "idle")
            return textResult("descendant idle")
          },
        }),
        "test",
      )
    }
    const outer = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
    const parent = outer.spawn({ prompt: "parent", ephemeral: true })
    await until(() => parent.state === "idle")
    expect(parent.send("parent follow-up")).toBe(true)
    if (wake === "before tools") {
      await until(() => active() === 1)
      expect(nested.send("nested follow-up")).toBe(true)
      await until(() => nested.state === "queued")
      parentModel.resolve()
    }
    await until(() => gates.has("nested follow-up"))
    const sibling = outer.spawn({ prompt: "sibling", ephemeral: true, maxTurns: 1 })
    await Bun.sleep(20)
    expect(sibling.state).toBe("queued")
    expect(active()).toBe(1)
    expect(peak()).toBe(1)
    gates.get("nested follow-up")!()
    await until(() => gates.has("sibling"))
    gates.get("sibling")!()
    expect((await sibling.result()).status).toBe("done")
    await until(() => parent.state === "idle")
    expect(nested.state).toBe("idle")
    expect(peak()).toBe(1)
  })
}
