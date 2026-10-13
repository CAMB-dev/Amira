import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import type { AnyEvent, ChildSession } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { AgentTree } from "../src/subagents.ts"

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

async function setup(maxConcurrent: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-interactive-admission-"))
  const gates = new Map<string, () => void>()
  const reply = (request: ModelRequest): MockReply => {
    const prompt = promptOf(request)
    const until = new Promise<void>((resolve) => gates.set(prompt, resolve))
    return { text: "held request", hold: { chunks: 0, until } }
  }
  const mock = createMockDialect(Array.from({ length: 30 }, () => reply))
  let active = 0
  let peak = 0
  const stream = mock.stream.bind(mock)
  // Measure actual overlapping model streams, not the tree's reported child states.
  mock.stream = async function* (request, context) {
    active++
    peak = Math.max(peak, active)
    try {
      yield* stream(request, context)
    } finally {
      active--
    }
  }
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, maxConcurrent, sections: () => [] })
  const root = new Agent({ ai, tree, cwd: dir, model: ai.model("mock/m"), bus: new EventBus() })
  cleanup.push(async () => {
    for (const release of gates.values()) release()
    await root.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { root, tree, mock, gates, active: () => active, peak: () => peak }
}

async function collect(child: ChildSession) {
  const events: AnyEvent[] = []
  for await (const event of child.events) events.push(event)
  return events
}

for (const maxConcurrent of [2, 3]) {
  test(`public workflow saturation reserves one slot and actual request peak stays at ${maxConcurrent}`, async () => {
    const { root, tree, mock, gates, active, peak } = await setup(maxConcurrent)
    const workflow = tree.createGroup(root, { name: "public workflow", maxConcurrent })
    const workers = Array.from({ length: maxConcurrent + 1 }, (_, i) =>
      workflow.spawn({ prompt: `worker ${i}` }),
    )
    await until(() => mock.requests.length >= maxConcurrent - 1)
    expect(mock.requests.map(promptOf)).toEqual(
      Array.from({ length: maxConcurrent - 1 }, (_, i) => `worker ${i}`),
    )
    expect(workers[maxConcurrent - 1]!.state).toBe("queued")
    const interactive = tree.spawn(root, { prompt: "interactive", ephemeral: true, maxTurns: 1 })
    await until(() => gates.has("interactive"))
    const queued = tree.spawn(root, { prompt: "another interactive", ephemeral: true, maxTurns: 1 })
    expect(queued.state).toBe("queued")
    expect(active()).toBe(maxConcurrent)
    expect(peak()).toBe(maxConcurrent)
    gates.get("interactive")!()
    await interactive.result()
    await until(() => gates.has("another interactive"))
    expect(active()).toBe(maxConcurrent)
    gates.get("another interactive")!()
    await queued.result()
    expect(workers[maxConcurrent - 1]!.state).toBe("queued")
    for (let i = 0; i < workers.length; i++) {
      await until(() => gates.has(`worker ${i}`))
      gates.get(`worker ${i}`)!()
      await workers[i]!.result()
    }
    expect(peak()).toBe(maxConcurrent)
    expect(active()).toBe(0)
  })
}

test("the reserved interactive place does not bypass a full private group", async () => {
  const { root, tree, mock, gates, active, peak } = await setup(3)
  const workers = ["worker a", "worker b", "worker queued"].map((prompt) => tree.spawn(root, { prompt }))
  await until(() => mock.requests.length >= 2)
  expect(mock.requests.map(promptOf)).toEqual(["worker a", "worker b"])
  workers[2]!.abort()
  await workers[2]!.result()
  gates.get("worker b")!()
  await workers[1]!.result()
  const group = tree.createGroup(root, { name: "private narrow", maxConcurrent: 1 })
  const a = group.spawn({ prompt: "private a", ephemeral: true, maxTurns: 1 })
  await until(() => gates.has("private a"))
  const b = group.spawn({ prompt: "private b", ephemeral: true, maxTurns: 1 })
  expect(b.state).toBe("queued")
  expect(active()).toBe(2)
  const other = tree.spawn(root, { prompt: "outside group", ephemeral: true, maxTurns: 1 })
  await until(() => gates.has("outside group"))
  expect(b.state).toBe("queued")
  expect(gates.has("private b")).toBe(false)
  gates.get("private a")!()
  await a.result()
  await until(() => gates.has("private b"))
  gates.get("private b")!()
  await b.result()
  gates.get("outside group")!()
  await other.result()
  gates.get("worker a")!()
  await workers[0]!.result()
  expect(peak()).toBe(3)
})

for (const delivery of ["send", "notice"] as const) {
  test(`private ${delivery} follow-up admits while the public workflow remains saturated`, async () => {
    const { root, tree, mock, gates, peak } = await setup(2)
    const child = tree.spawn(root, { prompt: "first", ephemeral: true, maxTurns: 2 })
    await until(() => gates.has("first"))
    gates.get("first")!()
    await until(() => child.state === "idle")
    const workflow = tree.createGroup(root, { name: "workflow", maxConcurrent: 2 })
    const a = workflow.spawn({ prompt: "public a" })
    const b = workflow.spawn({ prompt: "public b" })
    await until(() => gates.has("public a"))
    if (delivery === "send") expect(child.send("follow-up")).toBe(true)
    else child.expectNotice().deliver({ role: "user", content: [{ type: "text", text: "follow-up" }] })
    await until(() => mock.requests.length >= 3)
    expect(mock.requests.map(promptOf)).toEqual(["first", "public a", "follow-up"])
    expect(a.state).toBe("working")
    expect(b.state).toBe("queued")
    gates.get("follow-up")!()
    expect((await child.result()).turns).toBe(2)
    expect(peak()).toBe(2)
    gates.get("public a")!()
    await a.result()
    await until(() => gates.has("public b"))
    gates.get("public b")!()
    await b.result()
  })
}

test("maxConcurrent 1 exposes queued private initial and follow-up states without a bypass", async () => {
  const { root, tree, mock, gates, peak } = await setup(1)
  const a = tree.spawn(root, { prompt: "public first" })
  await until(() => gates.has("public first"))
  const child = tree.spawn(root, { prompt: "private first", ephemeral: true, maxTurns: 2 })
  const streamed = collect(child)
  expect(child.state).toBe("queued")
  expect(mock.requests.map(promptOf)).toEqual(["public first"])
  gates.get("public first")!()
  await a.result()
  await until(() => gates.has("private first"))
  gates.get("private first")!()
  await until(() => child.state === "idle")
  const b = tree.spawn(root, { prompt: "public second" })
  await until(() => gates.has("public second"))
  expect(child.send("private second")).toBe(true)
  await until(() => child.state === "queued")
  expect(mock.requests.map(promptOf)).toEqual(["public first", "private first", "public second"])
  gates.get("public second")!()
  await b.result()
  await until(() => gates.has("private second"))
  gates.get("private second")!()
  await child.result()
  expect(
    (await streamed).some(
      (event) => event.type === "subagent.state" && event.data.state === "queued" && event.data.turns === 1,
    ),
  ).toBe(true)
  expect(peak()).toBe(1)
})
