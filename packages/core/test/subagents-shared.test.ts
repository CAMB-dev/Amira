import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AskRequest, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree, type AgentTreeOptions } from "../src/subagents.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function setup(
  steps: MockStep[],
  options: Pick<AgentTreeOptions, "compaction" | "context" | "maxParallelTools"> = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "amira-shared-tree-"))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, maxConcurrent: 1, budget: { tokens: 100 }, ...options })
  const shared = new AgentTree({ ai, shared: tree })
  const root = new Agent({ ai, model: ai.model("mock/m"), cwd, tree })
  const owned = new Agent({ ai, model: ai.model("mock/m"), cwd, tree: shared })
  cleanup.push(
    () => root.dispose(),
    () => owned.dispose(),
  )
  return { tree, shared, root, owned, mock, ai, cwd }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for shared admission")
    await Bun.sleep(2)
  }
}

test("independent trees share admission and usage, but not children or disposal", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { tree, shared, root, owned, mock } = await setup([
    { text: "main child", hold: { chunks: 0, until: gate }, usage: { input: 7, output: 2 } },
    { text: "owned child", usage: { input: 3, output: 1 } },
  ])
  const main = tree.spawn(root, { prompt: "main" })
  await until(() => mock.requests.length === 1)
  const secondary = shared.spawn(owned, { prompt: "owned", persistent: true })
  await Bun.sleep(10)
  expect(mock.requests).toHaveLength(1)
  expect(secondary.state).toBe("queued")
  expect(tree.children.map((child) => child.id)).toEqual([main.id])
  expect(shared.children.map((child) => child.id)).toEqual([secondary.id])
  release()
  await main.result()
  await until(() => secondary.state === "idle")
  expect(tree.usage).toMatchObject({ input: 10, output: 3 })
  expect(shared.usage).toEqual(tree.usage)
  expect(shared.maxConcurrent).toBe(1)
  expect(shared.budget).toEqual({ tokens: 100 })
  await root.dispose("switch")
  expect(secondary.state).toBe("idle")
  expect(secondary.send("still owned")).toBe(true)
  await owned.dispose()
  expect((await secondary.result()).status).toBe("aborted")
})

test("owned root turns use shared admission and cancellation without entering child listings", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { tree, shared, root, owned, mock } = await setup([
    { text: "main child", hold: { chunks: 0, until: gate } },
    { text: "owned root", usage: { input: 4 } },
  ])
  const main = tree.spawn(root, { prompt: "main" })
  await until(() => mock.requests.length === 1)
  const abort = new AbortController()
  const cancelled = shared.runRoot(owned, () => owned.prompt("never sent"), abort.signal)
  abort.abort(new Error("cancelled queued root"))
  await expect(cancelled).rejects.toThrow("cancelled queued root")
  const sending = shared.runRoot(owned, () => owned.prompt("owned"), new AbortController().signal)
  await Bun.sleep(10)
  expect(mock.requests).toHaveLength(1)
  expect(shared.children).toEqual([])
  release()
  await main.result()
  expect(await sending).toMatchObject({ reason: "done" })
  expect(tree.usage).toMatchObject({ input: 4 })
})

test("owned root cancellation and task failures release admission and restore execution hooks", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { shared, owned, mock } = await setup([
    { text: "cancelled root", hold: { chunks: 0, until: gate }, usage: { input: 4, output: 2 } },
    { text: "retry", usage: { input: 3 } },
  ])
  cleanup.push(async () => {
    release()
  })
  const previous = { waiting: () => {}, returned: () => {}, ready: () => undefined }
  owned.execution.onTools = previous
  const abort = new AbortController()
  const active = shared.runRoot(owned, () => owned.prompt("cancel"), abort.signal)
  await until(() => mock.requests.length === 1)
  abort.abort(new Error("cancel active root"))
  release()
  expect(await active).toMatchObject({ reason: "aborted" })
  expect(owned.execution.onTools).toBe(previous)
  expect(shared.usage).toMatchObject({ input: 4, output: 2 })
  await expect(
    shared.runRoot(
      owned,
      async () => {
        throw new Error("failed task")
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("failed task")
  expect(owned.execution.onTools).toBe(previous)
  expect(
    await shared.runRoot(owned, () => owned.prompt("retry"), new AbortController().signal),
  ).toMatchObject({ reason: "done" })
  expect(shared.usage).toMatchObject({ input: 7, output: 2 })
  expect(mock.requests).toHaveLength(2)
})

test("admitted owned roots yield only for their own descendants and reacquire before model work", async () => {
  const { tree, shared, root, owned, mock } = await setup([
    { toolCalls: [{ name: "delegate", args: {} }] },
    { text: "nested child" },
    { text: "owned final" },
  ])
  owned.tools.register(
    defineTool({
      name: "delegate",
      description: "delegate",
      parameters: { type: "object" },
      execute: async (_args, ctx) =>
        textResult((await ctx.session!.spawn!({ prompt: "nested" }).result()).text),
    }),
    "test",
  )
  const result = await shared.runRoot(owned, () => owned.prompt("delegate"), new AbortController().signal)
  expect(result.reason).toBe("done")
  expect(mock.requests).toHaveLength(3)
  expect(shared.childrenOf(owned.sessionId)).toHaveLength(1)
  expect(tree.childrenOf(root.sessionId)).toEqual([])
})

test("shared budget exhaustion cancels active and queued owned roots in every scope", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { tree, shared, root, owned, ai, cwd, mock } = await setup([
    { text: "owned root", hold: { chunks: 0, until: gate } },
    { text: "budget spent", usage: { input: 101 } },
  ])
  const siblingTree = new AgentTree({ ai, shared })
  const sibling = new Agent({ ai, cwd, model: ai.model("mock/m"), tree: siblingTree })
  cleanup.push(
    () => sibling.dispose(),
    async () => {
      release()
    },
  )
  const active = shared.runRoot(owned, () => owned.prompt("active"), new AbortController().signal)
  await until(() => mock.requests.length === 1)
  let queuedEnded = false
  const queued = siblingTree.runRoot(sibling, () => sibling.prompt("queued"), new AbortController().signal)
  const queuedResult = queued.then(
    () => {
      queuedEnded = true
      return undefined
    },
    (error: unknown) => {
      queuedEnded = true
      return error
    },
  )
  await root.prompt("spend shared budget")
  expect(tree.usage.input).toBe(101)
  await until(() => queuedEnded)
  expect(await queuedResult).toBeInstanceOf(Error)
  expect(String(await queuedResult)).toContain("budget ran out")
  release()
  expect(await active).toMatchObject({ reason: "aborted" })
  expect(mock.requests).toHaveLength(2)
  await expect(
    shared.runRoot(owned, () => owned.prompt("refused"), new AbortController().signal),
  ).rejects.toThrow("budget is spent")
  expect(mock.requests).toHaveLength(2)
})

test("budget spent in a shared scope aborts host children and queued sibling children", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { tree, shared, root, owned, mock } = await setup([
    { text: "main child", hold: { chunks: 0, until: gate }, usage: { input: 7 } },
    { text: "budget spent", usage: { input: 101 } },
  ])
  cleanup.push(async () => {
    release()
  })
  let exceeded = 0
  owned.bus.subscribe(
    () => {
      exceeded++
    },
    { types: ["budget.exceeded"] },
  )
  const active = tree.spawn(root, { prompt: "main", persistent: true })
  await until(() => mock.requests.length === 1)
  const queued = shared.spawn(owned, { prompt: "queued" })
  await owned.prompt("spend shared budget")
  expect(await queued.result()).toMatchObject({
    status: "aborted",
    error: expect.stringContaining("budget ran out"),
  })
  release()
  expect(await active.result()).toMatchObject({
    status: "aborted",
    error: expect.stringContaining("budget ran out"),
  })
  expect(tree.usage.input).toBe(108)
  expect(shared.usage).toEqual(tree.usage)
  await owned.bus.flush()
  expect(exceeded).toBe(1)
  expect(mock.requests).toHaveLength(2)
  expect(() => tree.spawn(root, { prompt: "refused" })).toThrow("budget is spent")
})

test("local scope cancellation and disposal do not abort another scope's owned root", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { tree, shared, root, owned, mock } = await setup([
    { text: "still owned", hold: { chunks: 0, until: gate } },
    { text: "main queued" },
  ])
  cleanup.push(async () => {
    release()
  })
  const active = shared.runRoot(owned, () => owned.prompt("owned"), new AbortController().signal)
  await until(() => mock.requests.length === 1)
  tree.abortAll("local stop")
  await root.dispose("switch")
  expect(owned.busy).toBe(true)
  release()
  expect(await active).toMatchObject({ reason: "done" })
  expect(mock.requests).toHaveLength(1)
})

test("local scope cancellation rejects queued root permits without spending their model call", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { tree, shared, root, owned, mock } = await setup([
    { text: "host child", hold: { chunks: 0, until: gate } },
    { text: "owned retry" },
  ])
  cleanup.push(async () => {
    release()
  })
  const host = tree.spawn(root, { prompt: "main" })
  await until(() => mock.requests.length === 1)
  const queued = shared.runRoot(owned, () => owned.prompt("cancelled"), new AbortController().signal)
  shared.abortAll("owned stop")
  await expect(queued).rejects.toThrow("owned stop")
  expect(mock.requests).toHaveLength(1)
  release()
  expect(await host.result()).toMatchObject({ status: "done" })
  expect(
    await shared.runRoot(owned, () => owned.prompt("retry"), new AbortController().signal),
  ).toMatchObject({ reason: "done" })
  expect(mock.requests).toHaveLength(2)
})

test("disposed scopes can release their shared budget registration idempotently", async () => {
  const { tree, shared, root, owned } = await setup([{ text: "budget spent", usage: { input: 101 } }])
  await owned.dispose()
  shared.releaseScope()
  shared.releaseScope()
  const aborts = spyOn(shared, "abortAll")
  try {
    await root.prompt("spend budget")
    expect(tree.usage.input).toBe(101)
    expect(aborts).not.toHaveBeenCalled()
  } finally {
    aborts.mockRestore()
  }
})

test("shared descendants inherit host compaction, context and parallel-tool defaults", async () => {
  const compaction = { auto: false, keepTurns: 6 }
  const context = { saveAbove: 50, previewChars: 23 }
  const { shared, owned } = await setup(
    [
      {
        toolCalls: [
          { name: "serial", args: { index: 1 } },
          { name: "serial", args: { index: 2 } },
        ],
      },
      { text: "done" },
    ],
    { compaction, context, maxParallelTools: 1 },
  )
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  cleanup.push(async () => {
    release()
  })
  const started: number[] = []
  owned.tools.register(
    defineTool({
      name: "serial",
      description: "serial",
      parameters: {
        type: "object",
        properties: { index: { type: "number" } },
        required: ["index"],
      },
      execute: async (args: { index: number }) => {
        started.push(args.index)
        if (args.index === 1) await gate
        return textResult("done")
      },
    }),
    "test",
  )
  const child = shared.spawn(owned, { prompt: "serial tools" })
  if (!(child instanceof Child)) throw new Error("expected tree child")
  expect(child.agent.compaction).toEqual(compaction)
  expect(child.agent.context).toEqual(context)
  await until(() => started.length > 0)
  expect(started).toEqual([1])
  release()
  expect(await child.result()).toMatchObject({ status: "done" })
  expect(started).toEqual([1, 2])
})

test("restricted descendants exclude inherited shell declarations and reject shell extras", async () => {
  const { ai, cwd, tree } = await setup([{ text: "research" }])
  const restricted = new AgentTree({ ai, shared: tree, restricted: true })
  const parent = new Agent({ ai, cwd, model: ai.model("mock/m"), tree: restricted })
  cleanup.push(() => parent.dispose())
  for (const name of ["bash", "powershell", "custom_shell"]) {
    parent.tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        ...(name === "custom_shell" ? { traits: { shell: "bash" as const } } : {}),
        execute: async () => textResult("should not execute"),
      }),
      "test",
    )
  }
  const child = restricted.spawn(parent, { prompt: "research", persistent: true })
  if (!(child instanceof Child)) throw new Error("expected tree child")
  expect(child.agent.tools.list()).toEqual([])
  expect(() =>
    restricted.spawn(child.agent, {
      prompt: "cannot widen",
      extraTools: [parent.tools.get("custom_shell")!],
    }),
  ).toThrow("shell")
  await until(() => child.state === "idle")
  const grandchild = restricted.spawn(child.agent, { prompt: "nested research" })
  if (!(grandchild instanceof Child)) throw new Error("expected tree child")
  expect(grandchild.agent.tools.list()).toEqual([])
})

test("restricted descendant questions go directly to their owning asker without model consultation", async () => {
  const { ai, cwd, tree, mock } = await setup([
    { toolCalls: [{ name: "question", args: {} }] },
    { text: "human answered" },
  ])
  const restricted = new AgentTree({ ai, shared: tree, restricted: true })
  const questions: AskRequest[] = []
  const parent = new Agent({
    ai,
    cwd,
    model: ai.model("mock/m"),
    tree: restricted,
    ask: async (request) => {
      questions.push(request)
      return { answers: [{ selected: ["Human"] }] }
    },
  })
  cleanup.push(() => parent.dispose())
  parent.tools.register(
    defineTool({
      name: "question",
      description: "question",
      parameters: { type: "object" },
      execute: async (_args, ctx) =>
        textResult(
          JSON.stringify(
            await ctx.session!.askUser!(
              [{ question: "Who decides?", options: [{ label: "Human" }] }],
              ctx.signal,
            ),
          ),
        ),
    }),
    "test",
  )
  const child = restricted.spawn(parent, { prompt: "ask human" })
  expect(await child.result()).toMatchObject({ status: "done", text: "human answered" })
  expect(questions).toHaveLength(1)
  expect(questions[0]?.sessionId).toBe(child.id)
  expect(mock.requests).toHaveLength(2)
})
