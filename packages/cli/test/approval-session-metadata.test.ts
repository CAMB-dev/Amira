import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { type AskOutcome, defineTool, type EventMap, textResult } from "@amira/api"
import {
  Agent,
  AgentTree,
  EventBus,
  InterceptorRegistry,
  Permissions,
  ToolRegistry,
  UiRequests,
} from "@amira/core"
import { userApprover, userAsker } from "../src/session/approvals.ts"

for (const kind of ["approval", "question"] as const) {
  test(`a real restricted child's forwarded ${kind} keeps the child session metadata`, async () => {
    const mock = createMockDialect([
      { toolCalls: [{ id: "child-call", name: "inspect", args: {} }] },
      { text: "Done" },
    ])
    const ai = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
      retry: { retries: 0 },
    })
    const tree = new AgentTree({ ai, restricted: true, sections: () => [] })
    const bus = new EventBus()
    const ui = new UiRequests(bus)
    const requests: EventMap["ui.request"][] = []
    const sessions: string[] = []
    bus.subscribe((event) => {
      if (event.type !== "ui.request") return
      requests.push(event.data)
      sessions.push(event.sessionId)
      ui.respond(event.data.requestId, kind === "approval" ? false : [{ selected: ["A"] }])
    })
    const tools = new ToolRegistry()
    const questions = [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }]
    let outcome: AskOutcome | undefined
    let executed = 0
    tools.register(
      defineTool({
        name: "inspect",
        description: "Inspect the project",
        parameters: {},
        traits: { readOnly: true },
        execute: async (_args, ctx) => {
          executed++
          outcome = await ctx.session!.askUser!(questions, ctx.signal)
          return textResult("inspected")
        },
      }),
      "test",
    )
    const interceptors = new InterceptorRegistry()
    if (kind === "approval") {
      interceptors.add("tool.call.before", () => ({ action: "ask", reason: "Inspection approval" }))
    }
    const root = new Agent({
      ai,
      model: ai.model("mock/test"),
      cwd: process.cwd(),
      sections: [],
      bus,
      tree,
      tools,
      interceptors,
      permissions: new Permissions({ approver: userApprover(ui, { tree }) }),
      ask: userAsker(ui, tree),
    })
    try {
      const child = tree.spawn(root, { prompt: "Inspect", tools: ["inspect"], title: "Inspect child" })
      await child.result()
      await bus.flush()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        sessionId: child.id,
        source: kind === "approval" ? "approval" : "sub-agent",
        kind: kind === "approval" ? "confirm" : "ask",
      })
      expect(sessions).toEqual([child.id])
      expect(requests[0]?.sessionId).not.toBe(root.sessionId)
      if (kind === "question") {
        expect(requests[0]).toMatchObject({ questions })
        expect(outcome).toEqual({ answers: [{ selected: ["A"] }] })
        expect(executed).toBe(1)
      } else {
        expect(executed).toBe(0)
      }
    } finally {
      ui.cancelAll()
      await root.dispose()
    }
  })
}
