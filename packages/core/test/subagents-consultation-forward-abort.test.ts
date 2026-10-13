import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { type AskOutcome, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("an already-aborted ASK_USER escalation cannot queue behind an unanswered user callback", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-forward-abort-"))
  const opened = Promise.withResolvers<void>()
  const user = Promise.withResolvers<AskOutcome>()
  const cleanupReady = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  const controller = new AbortController()
  const calls: string[] = []
  let outcome: AskOutcome | undefined
  let active = 0
  const mock = createMockDialect(
    Array.from({ length: 10 }, () => (request: ModelRequest) => {
      const content = request.messages.at(-1)?.content[0]
      const prompt = content?.type === "text" ? content.text : ""
      if (prompt === "A" || prompt === "B")
        return { toolCalls: [{ name: "question", args: { label: prompt } }] }
      return { text: request.tools.length ? "done" : "ASK_USER" }
    }),
  )
  const stream = mock.stream.bind(mock)
  mock.stream = async function* (request, context) {
    active++
    try {
      for await (const event of stream(request, context)) {
        yield event
        if (
          !request.tools.length &&
          JSON.stringify(request.messages).includes("question B") &&
          event.type === "done"
        ) {
          cleanupReady.resolve()
          await cleanup.promise
        }
      }
    } finally {
      active--
    }
  }
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, maxConcurrent: 2, sections: () => [] })
  const tools = new ToolRegistry()
  const root = new Agent({
    ai,
    tree,
    tools,
    model: ai.model("mock/m"),
    cwd: dir,
    sections: [],
    ask: (request) => {
      calls.push(request.questions[0]!.question)
      opened.resolve()
      return user.promise
    },
  })
  tools.register(
    defineTool({
      name: "question",
      description: "question",
      parameters: { type: "object" },
      execute: async (args, ctx) => {
        const result = await ctx.session!.askUser!(
          [{ question: `question ${args.label}`, options: [{ label: "Yes" }] }],
          args.label === "B" ? controller.signal : ctx.signal,
        )
        if (args.label === "B") outcome = result
        return textResult("returned")
      },
    }),
    "test",
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    tree.spawn(root, { prompt: "A", ephemeral: true, maxTurns: 1 })
    await opened.promise
    const b = tree.spawn(root, { prompt: "B", ephemeral: true, maxTurns: 1 })
    await cleanupReady.promise
    controller.abort("cancel only B's question")
    cleanup.resolve()
    const completed = await Promise.race([
      b.result().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 500)
      }),
    ])
    expect({ completed, outcome, calls }).toEqual({
      completed: true,
      outcome: { declined: true },
      calls: ["question A"],
    })
    expect((await b.result()).status).toBe("done")
  } finally {
    clearTimeout(timer)
    controller.abort()
    cleanup.resolve()
    user.resolve({ answers: [{ selected: ["Yes"] }] })
    await root.dispose()
    expect(active).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  }
})
