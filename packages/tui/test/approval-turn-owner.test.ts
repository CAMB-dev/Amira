import { expect, test } from "bun:test"
import { type AgentPort, createLocalAgentPort, type UiRequests, type UiResponseAck } from "@amira/core"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const target of ["main", "focused"] as const) {
  for (const timing of [
    "ack after replacement",
    "answer after replacement",
    "request hidden until replacement",
    "request delivered after replacement",
    "owner still running",
    "request before first focus",
    "request before first focus after replacement",
  ] as const) {
    test(`${target}: approval cancellation stops only its request-time turn (${timing})`, async () => {
      const reply = Promise.withResolvers<void>()
      const delivery = Promise.withResolvers<void>()
      let ui!: UiRequests
      let acknowledgement: UiResponseAck | undefined
      let port: AgentPort | undefined
      const stops: { operation: string; params: unknown }[] = []
      const s = await focusFixture(
        "fullscreen",
        [
          { text: "Original turn ".repeat(80), delayMs: 5 },
          { text: "Replacement turn finishes normally ".repeat(10), delayMs: 3 },
        ],
        undefined,
        {
          frontend: (agent, commands) => {
            if (timing === "request delivered after replacement") {
              const subscribe = agent.bus.subscribe.bind(agent.bus)
              agent.bus.subscribe = (listener, options) =>
                subscribe(async (event) => {
                  if (event.type === "ui.request") await delivery.promise
                  return listener(event)
                }, options)
            }
            port = createLocalAgentPort({ agent, commands })
            const execute = port.execute.bind(port)
            port.execute = (operation, params, options) => {
              if (operation === "turn.abort" || operation === "conversation.stop")
                stops.push({ operation, params })
              return execute(operation, params, options)
            }
            return port
          },
          requests: {
            requestState: (id) => ui.requestState(id),
            respond: (id, value) => {
              acknowledgement = ui.respondAcknowledged(id, value)
              return reply.promise.then(() => acknowledgement!)
            },
            form: () => {
              throw new Error("not a form")
            },
            settings: () => {
              throw new Error("not settings")
            },
          },
        },
      )
      ui = s.host.ui
      const agent = target === "main" ? s.agent : s.owned
      const bus = target === "main" ? s.bus : s.ownedBus
      const ends: { id?: string; reason: string }[] = []
      const off = bus.subscribe((event) => {
        if (event.type === "turn.end") ends.push({ id: event.turnId, reason: event.data.reason })
      })
      let original: ReturnType<typeof agent.prompt> | undefined
      let replacement: ReturnType<typeof agent.prompt> | undefined
      try {
        const beforeFocus = target === "focused" && timing.startsWith("request before first focus")
        const hidden =
          timing === "request hidden until replacement" ||
          (beforeFocus && timing === "request before first focus after replacement")
        if ((target === "focused" || hidden) && !beforeFocus) {
          s.terminal.send("/design\r")
          await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
          if (target === "focused" && hidden) expect(s.context().unfocusConversation?.()).toBe(true)
        }
        original = agent.prompt("original")
        const owner = agent.turnId
        expect(owner).toBeDefined()
        await bus.flush()
        const delayedRequest = timing === "request delivered after replacement"
        const answer = ui.ask(
          { kind: "confirm", title: "Allow owned turn?" },
          { source: "approval", sessionId: agent.sessionId },
        )
        if (!delayedRequest) await s.bus.flush()
        if (beforeFocus && !hidden) {
          s.terminal.send("/design\r")
          await waitFor(() => s.live().includes("Design · fixture"), "first owned focus")
        }
        if (!hidden && !delayedRequest) await s.shows("Allow owned turn?")
        if (timing !== "answer after replacement" && !hidden && !delayedRequest) {
          s.terminal.send("\x1b")
          await waitFor(() => acknowledgement !== undefined, "host cancellation before acknowledgement")
          expect(acknowledgement).toEqual({ status: "cancelled" })
          await s.bus.flush() // ui.resolved removes presentation before the delayed acknowledgement.
        }
        if (timing !== "owner still running" && timing !== "request before first focus") {
          agent.abort()
          await original
          if (!delayedRequest) await bus.flush()
          replacement = agent.prompt("replacement")
          const next = agent.turnId
          expect(next).toBeDefined()
          expect(next).not.toBe(owner)
          delivery.resolve()
          await bus.flush()
          if (hidden) {
            if (target === "main") expect(s.context().unfocusConversation?.()).toBe(true)
            else if (beforeFocus) {
              s.terminal.send("/design\r")
              await waitFor(() => s.live().includes("Design · fixture"), "first focus after replacement")
            } else expect(s.context().focusConversation?.(s.conversation)).toBe(true)
            await s.shows("Allow owned turn?")
          }
          if (delayedRequest) await s.shows("Allow owned turn?")
          if (timing === "answer after replacement" || hidden || delayedRequest) {
            s.terminal.send("\x1b")
            await waitFor(() => acknowledgement !== undefined, "late cancellation")
            await s.bus.flush()
          }
          reply.resolve()
          await answer
          await Bun.sleep(30)
          expect(agent.turnId).toBe(next)
          await replacement
          await bus.flush()
          expect(ends.find((event) => event.id === next)?.reason).toBe("done")
        } else {
          reply.resolve()
          await answer
          await original
          await bus.flush()
          expect(ends).toEqual([{ id: owner, reason: "aborted" }])
          expect(stops).toEqual([
            target === "main"
              ? { operation: "turn.abort", params: { turnId: owner } }
              : {
                  operation: "conversation.stop",
                  params: {
                    conversationId: agent.sessionId,
                    incarnation: expect.any(String),
                    reason: "Interrupted from composer",
                    expectedTurnId: owner,
                  },
                },
          ])
        }
      } finally {
        reply.resolve()
        delivery.resolve()
        agent.abort()
        await Promise.all([original, replacement])
        off()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
        await port?.detach()
      }
    })
  }
}
