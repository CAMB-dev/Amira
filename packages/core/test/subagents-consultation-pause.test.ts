import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { type AskOutcome, defineTool, textResult } from "@amira/api"
import { Agent, type ApprovalDecision } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"
import { ParentConsultant } from "../src/subagents/consult-parent.ts"
import { consultationUsageRecorder } from "../src/subagents/consultation-usage.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

async function until(done: () => boolean) {
  const deadline = Date.now() + 2000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("admission state was not reached")
    await Bun.sleep(2)
  }
}
const promptOf = (request: ModelRequest) => {
  const content = request.messages.at(-1)?.content[0]
  return content?.type === "text" ? content.text : ""
}

// Admission completes before the physical queue is joined. An event-loop checkpoint after
// its explicit marker drains that continuation without guessing how long queueing takes.
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve))

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("consultation barrier was not reached")), 2000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function consultationFixture(kind: "approval" | "question") {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-queued-consultation-pause-"))
  const firstStarted = Promise.withResolvers<void>()
  const firstHeld = Promise.withResolvers<void>()
  const admitted = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const releases = new Map<string, number>()
  const charges: { requester: string; cost: number | undefined }[] = []
  const controllers: AbortController[] = []
  const calls: Promise<unknown>[] = []
  const signals: AbortSignal[] = []
  let active = 0
  let peak = 0
  const mock = createMockDialect(
    [3, 5, 7].map((cost, index) => () => {
      if (index === 0) firstStarted.resolve()
      return {
        text: kind === "approval" ? "APPROVE" : "1: Yes",
        usage: { cost },
        ...(index === 0 ? { hold: { chunks: 0, until: firstHeld.promise } } : {}),
      }
    }),
  )
  const stream = mock.stream.bind(mock)
  mock.stream = async function* (request, context) {
    signals.push(context.signal)
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
  const parent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    sections: [],
    session: SessionStore.create({ cwd: dir, dir }),
  })
  const consultant = new ParentConsultant({
    ai,
    callableTools: () => undefined,
    usageRecorder: (_owner, requester) =>
      consultationUsageRecorder((usage) => charges.push({ requester, cost: usage.cost })),
    acquire: async (requester) => {
      admitted.get(requester)!.resolve()
      return () => releases.set(requester, (releases.get(requester) ?? 0) + 1)
    },
  })
  const start = (requester: string) => {
    const controller = new AbortController()
    controllers.push(controller)
    const admission = Promise.withResolvers<void>()
    admitted.set(requester, admission)
    let settled = false
    const result: Promise<ApprovalDecision | AskOutcome> = (
      kind === "approval"
        ? consultant.approve(
            parent,
            { sessionId: requester, toolCallId: requester, name: "read", args: {}, reason: "approval" },
            controller.signal,
          )
        : consultant.ask(
            parent,
            {
              sessionId: requester,
              questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
            },
            controller.signal,
          )
    ).finally(() => {
      settled = true
    })
    calls.push(result)
    return {
      controller,
      result,
      queued: admission.promise.then(checkpoint),
      get settled() {
        return settled
      },
    }
  }
  return {
    parent,
    mock,
    firstStarted,
    firstHeld,
    releases,
    charges,
    signals,
    start,
    get active() {
      return active
    },
    get peak() {
      return peak
    },
    async dispose() {
      for (const controller of controllers) controller.abort("test cleanup")
      parent.execution.resume()
      firstHeld.resolve()
      try {
        try {
          await bounded(Promise.allSettled(calls))
        } finally {
          await bounded(parent.dispose())
        }
        expect(active).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

for (const kind of ["approval", "question"] as const) {
  const answered =
    kind === "approval" ? { approved: true } : { answers: [{ selected: ["Yes"] }], by: "the commander" }

  test(`queued ${kind} waits for its parent to resume without cancelling the running consultation`, async () => {
    const fixture = consultationFixture(kind)
    try {
      const first = fixture.start("first")
      await bounded(fixture.firstStarted.promise)
      const second = fixture.start("second")
      await bounded(second.queued)
      expect(fixture.mock.requests).toHaveLength(1)
      expect(fixture.parent.execution.pause()).toBe(true)
      expect(fixture.signals[0]!.aborted).toBe(false)
      expect(first.settled).toBe(false)
      fixture.firstHeld.resolve()
      expect(await bounded(first.result)).toEqual(answered)
      await checkpoint()
      expect(fixture.charges).toEqual([{ requester: "first", cost: 3 }])
      expect(fixture.releases.get("first")).toBe(1)
      expect(fixture.mock.requests).toHaveLength(1)
      expect(second.settled).toBe(false)
      expect(fixture.active).toBe(0)
      expect(fixture.parent.execution.resume()).toBe(true)
      expect(fixture.parent.execution.pause()).toBe(true)
      await checkpoint()
      expect(fixture.mock.requests).toHaveLength(1)
      expect(second.settled).toBe(false)
      expect(fixture.parent.execution.resume()).toBe(true)
      expect(await bounded(second.result)).toEqual(answered)
      expect(fixture.mock.requests).toHaveLength(2)
      expect(fixture.charges).toEqual([
        { requester: "first", cost: 3 },
        { requester: "second", cost: 5 },
      ])
      expect([...fixture.releases]).toEqual([
        ["first", 1],
        ["second", 1],
      ])
      expect(fixture.peak).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  test(`aborted queued ${kind} releases admission while the parent is paused and does not block the next requester`, async () => {
    const fixture = consultationFixture(kind)
    try {
      const first = fixture.start("first")
      await bounded(fixture.firstStarted.promise)
      const second = fixture.start("second")
      await bounded(second.queued)
      const third = fixture.start("third")
      await bounded(third.queued)
      expect(fixture.parent.execution.pause()).toBe(true)
      fixture.firstHeld.resolve()
      expect(await bounded(first.result)).toEqual(answered)
      await checkpoint()
      expect(fixture.mock.requests).toHaveLength(1)
      second.controller.abort("cancel the paused waiter")
      expect(await bounded(second.result)).toEqual(
        kind === "approval"
          ? { approved: false, reason: "the parent could not decide: aborted" }
          : { unavailable: "the commander could not answer: aborted" },
      )
      await checkpoint()
      expect(fixture.parent.execution.paused).toBe(true)
      expect(fixture.releases.get("second")).toBe(1)
      expect(fixture.releases.has("third")).toBe(false)
      expect(fixture.mock.requests).toHaveLength(1)
      expect(fixture.charges).toEqual([{ requester: "first", cost: 3 }])
      expect(third.settled).toBe(false)
      expect(fixture.parent.execution.resume()).toBe(true)
      expect(await bounded(third.result)).toEqual(answered)
      expect(fixture.mock.requests).toHaveLength(2)
      expect(promptOf(fixture.mock.requests[1]!)).toContain("session third")
      expect(fixture.charges).toEqual([
        { requester: "first", cost: 3 },
        { requester: "third", cost: 5 },
      ])
      expect([...fixture.releases]).toEqual([
        ["first", 1],
        ["second", 1],
        ["third", 1],
      ])
      expect(fixture.peak).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })
}

test("a paused requester retains its group slot after reacquiring for a consultation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-consultation-pause-"))
  const leafGate = Promise.withResolvers<void>()
  const approvalGate = Promise.withResolvers<void>()
  const siblingGate = Promise.withResolvers<void>()
  const leafStarted = Promise.withResolvers<void>()
  let approvalStarted = false
  let siblingStarted = false
  let active = 0
  const mock = createMockDialect(
    Array.from({ length: 10 }, () => (request: ModelRequest) => {
      const prompt = promptOf(request)
      if (request.messages.at(-1)?.role === "toolResult") return { text: "done" }
      if (prompt === "leader")
        return {
          toolCalls: [
            { name: "launch", args: {} },
            { name: "read", args: {} },
          ],
        }
      if (prompt === "leaf") {
        leafStarted.resolve()
        return { text: "leaf done", hold: { chunks: 0, until: leafGate.promise } }
      }
      if (prompt.includes('wants to call the tool "read"')) {
        approvalStarted = true
        return { text: "APPROVE", hold: { chunks: 0, until: approvalGate.promise } }
      }
      siblingStarted = true
      return { text: "sibling done", hold: { chunks: 0, until: siblingGate.promise } }
    }),
  )
  const stream = mock.stream.bind(mock)
  mock.stream = async function* (request, context) {
    active++
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
  const tree = new AgentTree({ ai, maxConcurrent: 3, sections: () => [] })
  const tools = new ToolRegistry()
  const root = new Agent({ ai, tree, tools, model: ai.model("mock/m"), cwd: dir, sections: [] })
  root.interceptors.add("tool.call.before", async (event) => {
    if (event.name !== "read") return { action: "pass" }
    await leafStarted.promise
    return { action: "ask", reason: "approval required" }
  })
  for (const name of ["launch", "read"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: {},
        concurrency: "parallel",
        execute: async (_args, ctx) => {
          if (name === "launch")
            await ctx.session!.spawn!({ prompt: "leaf", ephemeral: true, maxTurns: 1 }).result()
          return textResult("ok")
        },
      }),
      "test",
    )
  }
  try {
    const group = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
    const leader = group.spawn({ prompt: "leader", ephemeral: true, maxTurns: 1 })
    await leafStarted.promise
    leafGate.resolve()
    await until(() => approvalStarted)
    expect(active).toBe(1)
    expect(tree.pause(leader.id)).toBe(true)
    approvalGate.resolve()
    await until(() => active === 0)
    const sibling = group.spawn({ prompt: "sibling", ephemeral: true, maxTurns: 1 })
    await Bun.sleep(20)
    expect(sibling.state).toBe("queued")
    expect(siblingStarted).toBe(false)
    expect(active).toBe(0)
    expect(tree.resume(leader.id)).toBe(true)
    await until(() => siblingStarted)
    siblingGate.resolve()
    expect((await sibling.result()).status).toBe("done")
    expect((await leader.result()).status).toBe("done")
  } finally {
    leafGate.resolve()
    approvalGate.resolve()
    siblingGate.resolve()
    leafStarted.resolve()
    await root.dispose()
    expect(active).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  }
})
