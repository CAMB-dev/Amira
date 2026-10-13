import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { type AskOutcome, type AskQuestion, type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

async function until(done: () => boolean) {
  const deadline = Date.now() + 1000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("expected consultation state was not reached")
    await Bun.sleep(2)
  }
}

const questions: AskQuestion[] = [{ question: "Continue?", options: [{ label: "Yes" }] }]
const promptOf = (request: ModelRequest) => {
  const content = request.messages.at(-1)?.content[0]
  return content?.type === "text" ? content.text : ""
}

for (const scenario of ["direct answer", "uncontended escalation", "contended escalation"] as const) {
  test(`nested consultation completes with ${scenario} at tree and outer group cap one`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-consultation-cycle-"))
    const leafStarted = Promise.withResolvers<void>()
    const readAsked = Promise.withResolvers<void>()
    const contended = scenario !== "uncontended escalation"
    const escalation = scenario !== "direct answer"
    const consultations: string[] = []
    let leaf: ChildSession | undefined
    let outcome: AskOutcome | undefined
    let active = 0
    let peak = 0
    let readExecuted = false
    const mock = createMockDialect(
      Array.from({ length: 12 }, () => (request: ModelRequest) => {
        const prompt = promptOf(request)
        if (prompt === "L")
          return {
            toolCalls: [{ name: "launch", args: {} }, ...(contended ? [{ name: "read", args: {} }] : [])],
          }
        if (prompt === "C") {
          leafStarted.resolve()
          return {
            toolCalls: [{ name: "question", args: {} }],
            ...(contended ? { hold: { chunks: 0, until: readAsked.promise } } : {}),
          }
        }
        if (prompt.includes("asks you this question")) {
          const parent = request.systemPrompt.includes("ROLE L") ? "L" : "root"
          consultations.push(parent)
          return { text: parent === "L" && escalation ? "ASK_USER" : "1: Yes" }
        }
        if (prompt.includes('wants to call the tool "read"')) {
          consultations.push("approval")
          return { text: "APPROVE" }
        }
        return { text: "done" }
      }),
    )
    const stream = mock.stream.bind(mock)
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
    const tree = new AgentTree({ ai, maxConcurrent: 1, sections: () => [] })
    const tools = new ToolRegistry()
    const root = new Agent({ ai, tree, tools, model: ai.model("mock/m"), cwd: dir, sections: [] })
    root.interceptors.add("tool.call.before", async (event) => {
      if (event.name !== "read") return { action: "pass" }
      await leafStarted.promise
      readAsked.resolve()
      return { action: "ask", reason: "approval required" }
    })
    for (const name of ["launch", "read", "question"]) {
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
            } else if (name === "question") {
              outcome = await ctx.session!.askUser!(questions, ctx.signal)
            } else readExecuted = true
            return textResult("ok")
          },
        }),
        "test",
      )
    }
    const group = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
    const leader = group.spawn({ prompt: "L", systemPrompt: "ROLE L", ephemeral: true, maxTurns: 1 })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const completed = await Promise.race([
        leader.result().then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1000)
        }),
      ])
      // A failure identifies the precise cycle: L holds the root queue while waiting for
      // C's slot, and C holds that slot while waiting to escalate back into the root queue.
      expect({ completed, active, leader: leader.state, leaf: leaf?.state, consultations }).toEqual({
        completed: true,
        active: 0,
        leader: "ended",
        leaf: "ended",
        consultations: escalation
          ? contended
            ? ["L", "root", "approval"]
            : ["L", "root"]
          : ["L", "approval"],
      })
      expect((await leader.result()).status).toBe("done")
      expect((await leaf!.result()).status).toBe("done")
      expect(outcome).toEqual({ answers: [{ selected: ["Yes"] }], by: "the commander" })
      expect(readExecuted).toBe(contended)
      expect(peak).toBe(1)
    } finally {
      clearTimeout(timeout)
      leafStarted.resolve()
      readAsked.resolve()
      leader.abort("test cleanup")
      await root.dispose()
      expect(active).toBe(0)
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("parallel consultations by one requester retain stream caps when a descendant queues", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-consultation-cycle-"))
  const firstStarted = Promise.withResolvers<void>()
  const firstHeld = Promise.withResolvers<void>()
  const secondHeld = Promise.withResolvers<void>()
  const leafHeld = Promise.withResolvers<void>()
  let secondStarted = false
  let leafStarted = false
  let approvals = 0
  let active = 0
  let peak = 0
  let leaf: ChildSession | undefined
  const mock = createMockDialect(
    Array.from({ length: 12 }, () => (request: ModelRequest) => {
      const prompt = promptOf(request)
      if (prompt === "L")
        return {
          toolCalls: [
            { name: "read", args: { i: 1 } },
            { name: "read", args: { i: 2 } },
            { name: "launch", args: {} },
          ],
        }
      if (prompt === "C") {
        leafStarted = true
        return { text: "done", hold: { chunks: 0, until: leafHeld.promise } }
      }
      if (prompt.includes('wants to call the tool "read"')) {
        approvals++
        if (approvals === 1) firstStarted.resolve()
        else secondStarted = true
        return {
          text: "APPROVE",
          hold: { chunks: 0, until: approvals === 1 ? firstHeld.promise : secondHeld.promise },
        }
      }
      return { text: "done" }
    }),
  )
  const stream = mock.stream.bind(mock)
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
  const tree = new AgentTree({ ai, maxConcurrent: 1, sections: () => [] })
  const tools = new ToolRegistry()
  const root = new Agent({ ai, tree, tools, model: ai.model("mock/m"), cwd: dir, sections: [] })
  root.interceptors.add("tool.call.before", (event) =>
    event.name === "read" ? { action: "ask", reason: "approval required" } : { action: "pass" },
  )
  for (const name of ["launch", "read"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        concurrency: "parallel",
        execute: async (_args, ctx) => {
          if (name === "launch") {
            await firstStarted.promise
            leaf = ctx.session!.spawn!({ prompt: "C", ephemeral: true, maxTurns: 1 })
            await leaf.result()
          }
          return textResult("ok")
        },
      }),
      "test",
    )
  }
  const group = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
  const leader = group.spawn({ prompt: "L", ephemeral: true, maxTurns: 1 })
  try {
    await until(() => leaf?.state === "queued")
    expect(active).toBe(1)
    firstHeld.resolve()
    await until(() => secondStarted || leafStarted)
    await Bun.sleep(20)
    expect(active).toBe(1)
    expect(peak).toBe(1)
    // The descendant entered admission before the requester's second physical consultation.
    expect(leafStarted).toBe(true)
    expect(secondStarted).toBe(false)
    leafHeld.resolve()
    await until(() => secondStarted)
    secondHeld.resolve()
    await until(() => leader.state === "ended")
    expect((await leader.result()).status).toBe("done")
    expect((await leaf!.result()).status).toBe("done")
    expect(approvals).toBe(2)
    expect(peak).toBe(1)
  } finally {
    firstStarted.resolve()
    firstHeld.resolve()
    secondHeld.resolve()
    leafHeld.resolve()
    leader.abort("test cleanup")
    await root.dispose()
    expect(active).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  }
})
