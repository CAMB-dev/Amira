import { expect, test } from "bun:test"
import type { AgentPort } from "@amira/core"
import { createLocalAgentPort } from "@amira/core"
import { closeImageApp, exchange, setup, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const target of ["main", "focused"] as const) {
  test(`ordinary Escape cannot stop a replacement ${target} turn when host forwarding is delayed`, async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const forward = Promise.withResolvers<void>()
    let forwarded = false
    let port!: AgentPort
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
          port.execute = async (operation, params, options) => {
            if (operation === "turn.abort" || operation === "conversation.stop") {
              forwarded = true
              await forward.promise
            }
            return execute(operation, params, options)
          }
          return port
        },
      },
    )
    const agent = target === "main" ? s.agent : s.owned
    const bus = target === "main" ? s.bus : s.ownedBus
    try {
      if (target === "focused") {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "focused")
      }
      const original = agent.prompt("original")
      await bus.flush()
      s.terminal.send("\x1b")
      await waitFor(() => forwarded, "delayed stop")
      first.resolve()
      await original
      await bus.flush()
      const next = agent.prompt("replacement")
      await bus.flush()
      forward.resolve()
      await Bun.sleep(0)
      second.resolve()
      expect((await next).reason).toBe("done")
    } finally {
      first.resolve()
      second.resolve()
      forward.resolve()
      agent.abort()
      await agent.currentTurn
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
      await port.detach()
    }
  })
}

test("delayed Escape for compaction cannot abort a later model turn", async () => {
  const summary = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<void>()
  const forward = Promise.withResolvers<void>()
  let requested = false
  let port!: AgentPort
  const s = await setup(
    [
      { text: "summary", hold: { chunks: 0, until: summary.promise } },
      { text: "reply", hold: { chunks: 0, until: reply.promise } },
    ],
    {
      history: [...exchange("a"), ...exchange("b")],
      frontend: (agent) => {
        port = createLocalAgentPort({ agent })
        const execute = port.execute.bind(port)
        port.execute = async (operation, params, options) => {
          if (operation === "turn.abort") {
            requested = true
            await forward.promise
          }
          return execute(operation, params, options)
        }
        return port
      },
    },
  )
  try {
    const compacted = s.agent.compact()
    await waitFor(() => s.live().includes("Compacting the conversation"), "compaction")
    s.terminal.send("\x1b")
    await waitFor(() => requested, "delayed compaction stop")
    summary.resolve()
    await compacted
    await s.bus.flush()
    const next = s.agent.prompt("replacement")
    await s.bus.flush()
    forward.resolve()
    await Bun.sleep(0)
    reply.resolve()
    expect((await next).reason).toBe("done")
  } finally {
    summary.resolve()
    reply.resolve()
    forward.resolve()
    s.agent.abort()
    await s.idle()
    s.terminal.send("\x03\x03")
    await s.exited
    await port.detach()
    await s.agent.dispose()
  }
})
