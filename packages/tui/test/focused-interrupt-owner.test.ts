import { expect, test } from "bun:test"
import { type AgentPort, createLocalAgentPort } from "@amira/core"
import { conversationIncarnation } from "../../core/src/session-routing.ts"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

test("ordinary focused Escape cannot stop a replacement turn after delayed forwarding", async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const delivery = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  let port!: AgentPort
  let stopParams: unknown
  const s = await focusFixture(
    "fullscreen",
    [
      { text: "first", hold: { chunks: 0, until: first.promise } },
      { text: "second", hold: { chunks: 0, until: second.promise } },
    ],
    undefined,
    {
      frontend: (agent, commands) => {
        port = createLocalAgentPort({ agent, commands })
        const execute = port.execute.bind(port)
        port.execute = (operation, params, options) => {
          if (operation !== "conversation.stop") return execute(operation, params, options)
          stopParams = params
          return delivery.promise
            .then(() => execute(operation, params, options))
            .finally(() => stopped.resolve())
        }
        return port
      },
    },
  )
  let original: ReturnType<typeof s.owned.prompt> | undefined
  let replacement: ReturnType<typeof s.owned.prompt> | undefined
  try {
    s.terminal.send("/design\r")
    await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
    original = s.owned.prompt("original")
    const owner = s.owned.turnId
    await s.ownedBus.flush()
    s.terminal.send("\x1b")
    await waitFor(() => stopParams !== undefined, "delayed stop")
    first.resolve()
    await original
    await s.ownedBus.flush()
    replacement = s.owned.prompt("replacement")
    expect(s.owned.turnId).not.toBe(owner)
    delivery.resolve()
    await stopped.promise
    second.resolve()
    expect((await replacement).reason).toBe("done")
    expect(stopParams).toEqual({
      conversationId: s.owned.sessionId,
      incarnation: conversationIncarnation(s.conversation),
      reason: "Interrupted from composer",
      expectedTurnId: owner,
    })
  } finally {
    first.resolve()
    second.resolve()
    delivery.resolve()
    s.owned.abort()
    await Promise.all([original, replacement])
    s.context()?.unfocusConversation?.()
    await s.conversation.release()
    await closeImageApp(s)
    await port.detach()
  }
})

for (const replacementTurn of [false, true]) {
  test(`focused Escape cancels only its explicit hold (replacement: ${replacementTurn})`, async () => {
    const holdGate = Promise.withResolvers<void>()
    const turnGate = Promise.withResolvers<void>()
    const delivery = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    let port!: AgentPort
    let params: unknown
    const s = await focusFixture(
      "fullscreen",
      [{ text: "replacement", hold: { chunks: 0, until: turnGate.promise } }],
      undefined,
      {
        frontend: (agent, commands) => {
          port = createLocalAgentPort({ agent, commands })
          const execute = port.execute.bind(port)
          port.execute = (operation, input, options) => {
            if (operation !== "conversation.stop") return execute(operation, input, options)
            params = input
            return delivery.promise
              .then(() => execute(operation, input, options))
              .finally(() => stopped.resolve())
          }
          return port
        },
      },
    )
    let heldSignal!: AbortSignal
    let held: Promise<void> | undefined
    let replacement: ReturnType<typeof s.owned.prompt> | undefined
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
      held = s.owned.hold("compaction", (signal) => {
        heldSignal = signal
        return holdGate.promise
      })
      const expectedHoldId = s.owned.holdId
      expect(expectedHoldId).toBeDefined()
      s.terminal.send("\x1b")
      await waitFor(() => params !== undefined, "hold stop")
      if (replacementTurn) {
        holdGate.resolve()
        await held
        replacement = s.owned.prompt("replacement")
      }
      delivery.resolve()
      await stopped.promise
      expect(params).toEqual({
        conversationId: s.owned.sessionId,
        incarnation: conversationIncarnation(s.conversation),
        reason: "Interrupted from composer",
        expectedHoldId,
      })
      expect(heldSignal.aborted).toBe(!replacementTurn)
      turnGate.resolve()
      if (replacement) expect((await replacement).reason).toBe("done")
    } finally {
      holdGate.resolve()
      turnGate.resolve()
      delivery.resolve()
      s.owned.abort()
      await Promise.all([held, replacement])
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
      await port.detach()
    }
  })
}
