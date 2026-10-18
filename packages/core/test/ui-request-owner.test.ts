import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { uiRequestOwner } from "../src/ui-request-capture.ts"
import { UiRequests } from "../src/ui-requests.ts"

for (const descendant of [false, true]) {
  test(`request ownership is retained without frontend attachment (descendant: ${descendant})`, async () => {
    const gate = Promise.withResolvers<void>()
    const ai = createAi({
      dialects: [createMockDialect([{ text: "working", hold: { chunks: 0, until: gate.promise } }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    })
    const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
    const child = descendant
      ? new Agent({
          ai,
          model: ai.model("mock/m"),
          cwd: agent.cwd,
          parentSessionId: agent.sessionId,
          bus: agent.bus,
        })
      : undefined
    const ui = new UiRequests(agent.bus)
    const idle = ui.ask({ kind: "confirm", title: "Before any turn" }, { source: "approval" })
    const idleId = ui.pending[0]!.requestId
    const running = agent.prompt("original")
    const owner = agent.turnId
    const answer = ui.ask(
      { kind: "confirm", title: "During original turn" },
      { source: "approval", ...(child ? { sessionId: child.sessionId } : {}) },
    )
    const requestId = ui.pending[1]!.requestId
    try {
      expect(owner).toBeDefined()
      expect(uiRequestOwner(ui, idleId)).toEqual({ sessionId: agent.sessionId, turnId: undefined })
      expect(uiRequestOwner(ui, requestId)).toEqual({ sessionId: agent.sessionId, turnId: owner })
      expect(Object.isFrozen(uiRequestOwner(ui, requestId))).toBe(true)
      gate.resolve()
      await running
      expect(uiRequestOwner(ui, requestId)?.turnId).toBe(owner)
      ui.cancel(requestId)
      expect(await answer).toBeUndefined()
      expect(uiRequestOwner(ui, requestId)).toBeUndefined()
    } finally {
      gate.resolve()
      ui.cancelAll()
      agent.abort()
      await running
      await idle
      await child?.dispose()
      await agent.dispose()
    }
  })
}

test("constructing an inactive root cannot steal host-default request ownership", async () => {
  const gate = Promise.withResolvers<void>()
  const ai = createAi({
    dialects: [createMockDialect([{ text: "working", hold: { chunks: 0, until: gate.promise } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const active = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  const ui = new UiRequests(active.bus)
  const running = active.prompt("active")
  const candidate = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: active.cwd,
    bus: active.bus,
    systemPrompt: "",
  })
  const answer = ui.api("approval").confirm("Still owned by active root")
  try {
    expect(uiRequestOwner(ui, ui.pending[0]!.requestId)).toEqual({
      sessionId: active.sessionId,
      turnId: active.turnId,
    })
  } finally {
    ui.cancelAll()
    gate.resolve()
    await answer
    await running
    await candidate.dispose()
    await active.dispose()
  }
})
