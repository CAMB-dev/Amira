import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { conversationIncarnation, conversationTurnId, sendConversation } from "../src/session-routing.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { uiRequestOwner } from "../src/ui-request-capture.ts"
import { UiRequests } from "../src/ui-requests.ts"

test("a real unfocused owned handle retains its request owner and frontend send identity", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-request-owner-"))
  const gate = Promise.withResolvers<void>()
  const ai = createAi({
    dialects: [createMockDialect([{ text: "working", hold: { chunks: 0, until: gate.promise } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, model: ai.model("mock/m"), cwd: home, tools, tree })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  const ui = new UiRequests(main.bus)
  let running: Promise<void> | undefined
  try {
    const conversation = await manager
      .forOwner("checks")
      .openOrCreate(
        { key: "checks", name: "Checks", cwd: home, systemPrompt: "", callableTools: [] },
        { askUser: async () => undefined },
      )
    const events = conversation.events[Symbol.asyncIterator]()
    const turnId = crypto.randomUUID()
    running = sendConversation(conversation, "owned request", undefined, turnId)
    while (true) {
      const next = await events.next()
      if (next.done) throw new Error("conversation closed before turn start")
      if (next.value.type !== "turn.start") continue
      expect(next.value.turnId).toBe(turnId)
      break
    }
    expect(conversationTurnId(conversation)).toBe(turnId)
    const answer = ui.ask(
      { kind: "confirm", title: "Unfocused approval" },
      { source: "approval", sessionId: conversation.id },
    )
    const requestId = ui.pending[0]!.requestId
    expect(uiRequestOwner(ui, requestId)).toEqual({
      sessionId: conversation.id,
      turnId,
      conversationIncarnation: conversationIncarnation(conversation),
    })
    gate.resolve()
    await running
    expect(conversationTurnId(conversation)).toBeUndefined()
    expect(uiRequestOwner(ui, requestId)).toEqual({
      sessionId: conversation.id,
      turnId,
      conversationIncarnation: conversationIncarnation(conversation),
    })
    const originalIncarnation = conversationIncarnation(conversation)
    await conversation.release()
    const reopened = await manager
      .forOwner("checks")
      .open(conversation.id, { askUser: async () => undefined })
    expect(conversationIncarnation(reopened)).not.toBe(originalIncarnation)
    expect(uiRequestOwner(ui, requestId)?.conversationIncarnation).toBe(originalIncarnation)
    const nextAnswer = ui.ask(
      { kind: "confirm", title: "Replacement approval" },
      { source: "approval", sessionId: reopened.id },
    )
    const nextId = ui.pending.find((request) => request.requestId !== requestId)!.requestId
    expect(uiRequestOwner(ui, nextId)?.conversationIncarnation).toBe(conversationIncarnation(reopened))
    ui.cancel(nextId)
    await nextAnswer
    ui.cancel(requestId)
    expect(await answer).toBeUndefined()
    await events.return?.()
  } finally {
    gate.resolve()
    ui.cancelAll()
    await running
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
