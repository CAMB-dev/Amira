import { expect, test } from "bun:test"
import { type AgentPort, createLocalAgentPort } from "@amira/core"
import { closeImageApp, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

test("a focused send admitted before a late rejection never restores consumed text or images", async () => {
  const running = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<never>()
  void reply.promise.catch(() => {})
  let port!: AgentPort
  let sends = 0
  const s = await focusFixture(
    "fullscreen",
    [{ text: "original", hold: { chunks: 0, until: running.promise } }, { text: "next" }],
    undefined,
    {
      frontend: (agent, commands) => {
        port = createLocalAgentPort({ agent, commands })
        const execute = port.execute.bind(port)
        port.execute = (operation, params, options) => {
          if (operation !== "conversation.send" || ++sends !== 1) return execute(operation, params, options)
          void execute(operation, params, options).catch(() => {})
          return reply.promise
        }
        return port
      },
    },
  )
  try {
    s.terminal.send("/design\r")
    await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
    s.terminal.send("consumed\x16")
    await waitFor(() => s.live().includes("[image 1:"), "image draft")
    s.terminal.send("\r")
    await waitFor(() => s.owned.turnId !== undefined, "admitted send")
    await s.ownedBus.flush()
    reply.reject(new Error("late acknowledgement rejection"))
    await Bun.sleep(0)
    running.resolve()
    await waitFor(() => !s.owned.busy, "original completion")
    await s.ownedBus.flush()
    s.terminal.send("fresh\r")
    await waitFor(() => userTexts(s.owned).length === 3, "next send")
    expect(userTexts(s.owned)).toEqual(["Design history", "consumed", "fresh"])
    const users = s.owned.messages.filter((message) => message.role === "user")
    expect(users[1]!.content.some((block) => block.type === "image")).toBe(true)
    expect(users[2]!.content.some((block) => block.type === "image")).toBe(false)
  } finally {
    running.resolve()
    reply.reject(new Error("cleanup"))
    s.context()?.unfocusConversation?.()
    await s.conversation.release()
    await closeImageApp(s)
    await port.detach()
  }
})

test("a focused model-error end releases sending before its late reply, without clearing a newer admission", async () => {
  const reply = Promise.withResolvers<never>()
  void reply.promise.catch(() => {})
  const admission = Promise.withResolvers<void>()
  let port!: AgentPort
  let sends = 0
  const s = await focusFixture(
    "fullscreen",
    [{ error: { message: "mock model failure" } }, { text: "replacement" }],
    undefined,
    {
      frontend: (agent, commands) => {
        port = createLocalAgentPort({ agent, commands })
        const execute = port.execute.bind(port)
        port.execute = (operation, params, options) => {
          if (operation !== "conversation.send") return execute(operation, params, options)
          sends++
          if (sends === 1) {
            void execute(operation, params, options).catch(() => {})
            return reply.promise
          }
          return admission.promise.then(() => execute(operation, params, options))
        }
        return port
      },
    },
  )
  let ended = false
  const off = s.ownedBus.subscribe((event) => {
    if (event.type === "turn.end") ended = true
  })
  try {
    s.terminal.send("/design\r")
    await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
    s.terminal.send("failed but consumed\r")
    await waitFor(() => ended, "model-error completion")
    await s.ownedBus.flush()
    s.terminal.send("next\r")
    await waitFor(() => sends === 2, "new send while old reply pending")
    reply.reject(new Error("late model-error rejection"))
    await Bun.sleep(0)
    s.terminal.send("must wait\r")
    await Bun.sleep(0)
    expect(sends).toBe(2)
    admission.resolve()
    await waitFor(() => userTexts(s.owned).length === 3, "second admission")
    expect(userTexts(s.owned)).toEqual(["Design history", "failed but consumed", "next"])
  } finally {
    reply.reject(new Error("cleanup"))
    admission.resolve()
    off()
    s.context()?.unfocusConversation?.()
    await s.conversation.release()
    await closeImageApp(s)
    await port.detach()
  }
})
