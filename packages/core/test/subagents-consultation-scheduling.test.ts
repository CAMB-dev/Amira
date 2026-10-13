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

test("independently aborted ask retains requester ordering through physical cleanup", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-consultation-scheduling-"))
  const firstStarted = Promise.withResolvers<void>()
  const cleanupReady = Promise.withResolvers<void>()
  const cleanupHeld = Promise.withResolvers<void>()
  const secondHeld = Promise.withResolvers<void>()
  const leafHeld = Promise.withResolvers<void>()
  const firstController = new AbortController()
  let asks = 0
  let secondStarted = false
  let leafStarted = false
  let active = 0
  let peak = 0
  let leaf: ChildSession | undefined
  let firstOutcome: AskOutcome | undefined
  let secondOutcome: AskOutcome | undefined
  const mock = createMockDialect(
    Array.from({ length: 12 }, () => (request: ModelRequest) => {
      const prompt = promptOf(request)
      if (prompt === "L") return { toolCalls: [{ name: "question", args: {} }] }
      if (prompt === "D") {
        leafStarted = true
        return { text: "done", hold: { chunks: 0, until: leafHeld.promise } }
      }
      if (prompt.includes("asks you this question")) {
        asks++
        if (asks === 1) {
          firstStarted.resolve()
          return { text: "1: Yes", delayMs: 10_000 }
        }
        secondStarted = true
        return { text: "1: Yes", hold: { chunks: 0, until: secondHeld.promise } }
      }
      return { text: "done" }
    }),
  )
  const stream = mock.stream.bind(mock)
  mock.stream = async function* (request, context) {
    const first = promptOf(request).includes("asks you this question") && asks === 0
    active++
    peak = Math.max(peak, active)
    try {
      yield* stream(request, context)
    } finally {
      if (first) {
        cleanupReady.resolve()
        await cleanupHeld.promise
      }
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
  tools.register(
    defineTool({
      name: "question",
      description: "question",
      parameters: { type: "object" },
      execute: async (_args, ctx) => {
        const first = ctx.session!.askUser!(questions, firstController.signal)
        await firstStarted.promise
        firstController.abort("cancel only the first question")
        await cleanupReady.promise
        const second = ctx.session!.askUser!(questions, ctx.signal)
        // Keep the requester alive while its first physical stream is still cleaning up.
        await Bun.sleep(20)
        leaf = ctx.session!.spawn!({ prompt: "D", ephemeral: true, maxTurns: 1 })
        firstOutcome = await first
        secondOutcome = await second
        await leaf.result()
        return textResult("ok")
      },
    }),
    "test",
  )
  const group = tree.createGroup(root, { name: "outer", maxConcurrent: 1 })
  const leader = group.spawn({ prompt: "L", ephemeral: true, maxTurns: 1 })
  try {
    await until(() => leaf?.state === "queued")
    expect(leader.state).not.toBe("ended")
    expect(active).toBe(1)
    expect(asks).toBe(1)
    expect(secondStarted).toBe(false)
    cleanupHeld.resolve()
    await until(() => leafStarted || secondStarted)
    await Bun.sleep(20)
    expect({ active, peak, leafStarted, secondStarted }).toEqual({
      active: 1,
      peak: 1,
      leafStarted: true,
      secondStarted: false,
    })
    leafHeld.resolve()
    await until(() => secondStarted)
    expect(active).toBe(1)
    secondHeld.resolve()
    await until(() => leader.state === "ended")
    expect((await leader.result()).status).toBe("done")
    expect(firstOutcome).toHaveProperty("unavailable")
    expect(secondOutcome).toEqual({ answers: [{ selected: ["Yes"] }], by: "the commander" })
    expect(asks).toBe(2)
    expect(peak).toBe(1)
  } finally {
    firstController.abort()
    cleanupHeld.resolve()
    secondHeld.resolve()
    leafHeld.resolve()
    leader.abort("test cleanup")
    await root.dispose()
    expect(active).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const scenario of ["direct answer", "uncontended escalation", "contended escalation"] as const) {
  test(`depth-three consultation completes with ${scenario} at tree and outer group cap one`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-consultation-scheduling-"))
    const firstConsultStarted = Promise.withResolvers<void>()
    const descendantQueued = Promise.withResolvers<void>()
    const escalation = scenario !== "direct answer"
    const contended = scenario !== "uncontended escalation"
    const consultations: string[] = []
    const outcomes: AskOutcome[] = []
    let child: ChildSession | undefined
    let descendant: ChildSession | undefined
    let active = 0
    let peak = 0
    const mock = createMockDialect(
      Array.from({ length: 20 }, () => (request: ModelRequest) => {
        const prompt = promptOf(request)
        if (prompt === "L") return { toolCalls: [{ name: "launch", args: { role: "C" } }] }
        if (prompt === "C")
          return {
            toolCalls: [
              ...(contended ? [{ name: "question", args: {} }] : []),
              { name: "launch", args: { role: "D" } },
            ],
          }
        if (prompt === "D") return { toolCalls: [{ name: "question", args: {} }] }
        if (prompt.includes("asks you this question")) {
          const parent = request.systemPrompt.includes("ROLE C")
            ? "C"
            : request.systemPrompt.includes("ROLE L")
              ? "L"
              : "root"
          consultations.push(parent)
          if (contended && consultations.length === 1) firstConsultStarted.resolve()
          return {
            text: escalation && parent !== "root" ? "ASK_USER" : "1: Yes",
            ...(contended && consultations.length === 1
              ? { hold: { chunks: 0, until: descendantQueued.promise } }
              : {}),
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
    const tree = new AgentTree({ ai, maxConcurrent: 1, maxDepth: 3, sections: () => [] })
    const tools = new ToolRegistry()
    const root = new Agent({ ai, tree, tools, model: ai.model("mock/m"), cwd: dir, sections: [] })
    tools.register(
      defineTool({
        name: "launch",
        description: "launch",
        parameters: { type: "object", properties: { role: { type: "string" } }, required: ["role"] },
        concurrency: "parallel",
        execute: async (args, ctx) => {
          if (args.role === "D" && contended) await firstConsultStarted.promise
          const spawned = ctx.session!.spawn!({
            prompt: args.role,
            systemPrompt: `ROLE ${args.role}`,
            ephemeral: true,
            maxTurns: 1,
          })
          if (args.role === "C") child = spawned
          else {
            descendant = spawned
            expect(spawned.state).toBe("queued")
            descendantQueued.resolve()
          }
          await spawned.result()
          return textResult("ok")
        },
      }),
      "test",
    )
    tools.register(
      defineTool({
        name: "question",
        description: "question",
        parameters: { type: "object" },
        concurrency: "parallel",
        execute: async (_args, ctx) => {
          outcomes.push(await ctx.session!.askUser!(questions, ctx.signal))
          return textResult("ok")
        },
      }),
      "test",
    )
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
      // C's escalation must not hold L's forwarding line while waiting for D's slot;
      // D needs that same line after its C -> L -> root escalation.
      expect({
        completed,
        active,
        leader: leader.state,
        child: child?.state,
        descendant: descendant?.state,
        consultations,
      }).toEqual({
        completed: true,
        active: 0,
        leader: "ended",
        child: "ended",
        descendant: "ended",
        consultations: escalation
          ? contended
            ? ["L", "C", "L", "root", "root"]
            : ["C", "L", "root"]
          : ["L", "C"],
      })
      expect((await leader.result()).status).toBe("done")
      expect((await child!.result()).status).toBe("done")
      expect((await descendant!.result()).status).toBe("done")
      expect(outcomes).toEqual(
        Array.from({ length: contended ? 2 : 1 }, () => ({
          answers: [{ selected: ["Yes"] }],
          by: "the commander",
        })),
      )
      expect(peak).toBe(1)
    } finally {
      clearTimeout(timeout)
      firstConsultStarted.resolve()
      descendantQueued.resolve()
      leader.abort("test cleanup")
      await root.dispose()
      expect(active).toBe(0)
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
