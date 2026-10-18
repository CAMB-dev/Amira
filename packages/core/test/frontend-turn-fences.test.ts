import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { createLocalAgentPort } from "../src/frontend/local-port.ts"
import { bindLocalConversation } from "../src/frontend/operations.ts"
import { registerConversationTurn } from "../src/session-routing.ts"

function fixture(steps: MockStep[] = []) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  return { agent, port: createLocalAgentPort({ agent }) }
}

test("an old approval abort arriving at the host after a new turn starts cannot abort the new turn", async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<void>()
  const s = fixture([
    { text: "first", hold: { chunks: 0, until: first.promise } },
    { text: "second", hold: { chunks: 0, until: second.promise } },
  ])
  try {
    await s.port.execute("turn.prompt", { message: "one" })
    const turnId = s.agent.turnId!
    const oldAbort = delivered.promise.then(() =>
      s.port.execute("turn.abort", JSON.parse(JSON.stringify({ turnId }))),
    )
    const firstTurn = s.agent.currentTurn
    first.resolve()
    await firstTurn
    await s.port.execute("turn.prompt", { message: "two" })
    expect(s.agent.turnId).not.toBe(turnId)
    const nextTurn = s.agent.currentTurn
    delivered.resolve()
    await oldAbort
    second.resolve()
    expect((await nextTurn)?.reason).toBe("done")
  } finally {
    first.resolve()
    second.resolve()
    delivered.resolve()
    await s.port.detach()
    await s.agent.dispose()
  }
})

for (const scoped of [false, true]) {
  test(`${scoped ? "matching scoped" : "legacy unscoped"} abort still interrupts the active turn`, async () => {
    const gate = Promise.withResolvers<void>()
    const s = fixture([{ text: "waiting", hold: { chunks: 0, until: gate.promise } }])
    try {
      await s.port.execute("turn.prompt", { message: "one" })
      const turn = s.agent.currentTurn
      await s.port.execute("turn.abort", scoped ? { turnId: s.agent.turnId } : {})
      gate.resolve()
      expect((await turn)?.reason).toBe("aborted")
    } finally {
      gate.resolve()
      await s.port.detach()
      await s.agent.dispose()
    }
  })
}

test("a delayed focused approval stop is checked against host turn authority", async () => {
  const s = fixture()
  let turnId: string | undefined = "old"
  const stops: (string | undefined)[] = []
  const conversation = {
    id: "owned",
    stop: async () => {
      stops.push(turnId)
    },
  } as OwnedConversation
  registerConversationTurn(conversation, () => turnId)
  const unbind = bindLocalConversation(s.port, conversation)
  try {
    turnId = "new"
    await s.port.execute("conversation.stop", {
      conversationId: "owned",
      incarnation: unbind.incarnation,
      expectedTurnId: "old",
    })
    expect(stops).toEqual([])
    await s.port.execute("conversation.stop", {
      conversationId: "owned",
      incarnation: unbind.incarnation,
      expectedTurnId: "new",
    })
    expect(stops).toEqual(["new"])
    turnId = undefined
    await s.port.execute("conversation.stop", {
      conversationId: "owned",
      incarnation: unbind.incarnation,
      expectedTurnId: "new",
    })
    expect(stops).toEqual(["new"])
    await s.port.execute("conversation.stop", { conversationId: "owned", incarnation: unbind.incarnation })
    expect(stops).toEqual(["new", undefined])
  } finally {
    unbind()
    await s.port.detach()
    await s.agent.dispose()
  }
})
