import { expect, spyOn, test } from "bun:test"
import { type AgentPort, createLocalAgentPort } from "@amira/core"
import { setup, waitFor } from "./app-harness.ts"

for (const kind of ["confirm", "form"] as const) {
  test(`detachable quit keeps a pending ${kind} and its command alive`, async () => {
    let frontend!: AgentPort
    let signal: AbortSignal | undefined
    const complete = Promise.withResolvers<void>()
    const s = await setup([], {
      frontend: (agent, commands) => {
        frontend = Object.assign(createLocalAgentPort({ agent, commands }), {
          quitBehavior: "detach" as const,
        })
        return frontend
      },
      commands: [
        {
          name: "detach",
          description: "Detach test",
          run: async (_args, context) => {
            signal = context.signal
            const pending =
              kind === "form"
                ? context.ui.form({
                    title: "Keep this form",
                    fields: [{ type: "text", id: "value", label: "Value" }],
                  })
                : context.ui.confirm("Keep this approval")
            await s.bus.flush()
            context.quit?.()
            await pending
            complete.resolve()
          },
        },
      ],
    })
    const detach = spyOn(frontend, "detach")
    try {
      s.terminal.send("/detach\r")
      expect(await s.exited).toBe(0)
      expect(detach).toHaveBeenCalledTimes(1)
      expect(signal?.aborted).toBe(false)
      expect(s.host.ui.pending).toHaveLength(1)
      const request = s.host.ui.pending[0]!
      expect(request.kind).toBe(kind)
      expect(
        s.host.ui.respondAcknowledged(request.requestId, kind === "form" ? { value: "answer" } : true),
      ).toEqual({ status: "accepted" })
      await complete.promise
    } finally {
      s.host.ui.cancelAll()
      await frontend.detach()
      await s.agent.dispose()
    }
  })
}

test("detachable quit does not warn that background jobs will stop", async () => {
  let detached = false
  const s = await setup([], {
    runningJobs: () => 2,
    frontend: (agent) => {
      const port = createLocalAgentPort({ agent })
      return {
        quitBehavior: "detach",
        get snapshot() {
          return port.snapshot
        },
        subscribe: port.subscribe.bind(port),
        execute: port.execute.bind(port),
        detach: async () => {
          detached = true
          await port.detach()
        },
      }
    },
  })
  try {
    await waitFor(() => s.live().includes("Message Amira"), "composer")
    s.terminal.send("\x03")
    expect(await s.exited).toBe(0)
    expect(detached).toBe(true)
    expect(s.live()).not.toContain("again to stop them")
  } finally {
    await s.agent.dispose()
  }
})

test("detach does not cancel an already admitted form action", async () => {
  const gate = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const actionDone = Promise.withResolvers<void>()
  const s = await setup([], {
    frontend: (agent, commands) =>
      Object.assign(createLocalAgentPort({ agent, commands }), { quitBehavior: "detach" as const }),
    commands: [
      {
        name: "detach",
        description: "Detach test",
        run: async (_args, context) => {
          const answer = context.ui.form({
            title: "Pending action",
            fields: [
              { type: "select", id: "choice", label: "Choice", options: [{ value: "original" }] },
              {
                type: "action",
                id: "load",
                label: "Load",
                auto: { watch: ["choice"], ready: () => true },
                run: async (action) => {
                  signal = action.signal
                  await gate.promise
                  actionDone.resolve()
                  return { options: { choice: [{ value: "loaded" }] } }
                },
              },
            ],
          })
          await waitFor(() => signal !== undefined, "admitted action")
          context.quit()
          await answer
        },
      },
    ],
  })
  try {
    s.terminal.send("/detach\r")
    expect(await s.exited).toBe(0)
    expect(signal?.aborted).toBe(false)
    gate.resolve()
    await actionDone.promise
    await Bun.sleep(0)
    const request = s.host.ui.pending[0]!
    expect(s.host.ui.formOptions(request.requestId)).toEqual({ choice: [{ value: "loaded" }] })
  } finally {
    gate.resolve()
    s.host.ui.cancelAll()
    await s.agent.dispose()
  }
})
