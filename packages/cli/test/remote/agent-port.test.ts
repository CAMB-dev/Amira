import { expect, test } from "bun:test"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

test("remote port exposes immutable host snapshots and async operations over fragmented codecs", async () => {
  const f = await agentPortFixture()
  try {
    expect(f.port.status).toBe("connected")
    expect(f.port.connection).toBe("connected")
    expect(f.port.quitBehavior).toBe("detach")
    expect(Object.isFrozen(f.port.snapshot)).toBe(true)
    expect(f.port.snapshot.state.cwd).toBe(f.port.authority!.workspace)
    const original = f.port.snapshot
    const events: string[] = []
    f.port.subscribeEvents((event) => {
      events.push(event.type)
    })
    expect(await f.port.request("models.list", {})).toMatchObject([{ ref: "mock/test" }])
    expect(await f.port.execute("turn.prompt", { message: "hello" })).toMatchObject({ sessionGeneration: 1 })
    await until(() => f.port.snapshot.transcript.messages.length >= 2)
    expect(f.mock.requests).toHaveLength(1)
    expect(events).toContain("message.end")
    expect(original.transcript.messages).toHaveLength(0)
    expect(await f.port.execute("state.read", {})).toMatchObject({ sessionId: f.port.identity.sessionId })
  } finally {
    await f.close()
  }
})

test("remote reconnect retains controller/cursor and marks historical events as replay", async () => {
  const f = await agentPortFixture()
  try {
    const token = f.port.authority!.controllerToken
    const generation = f.port.authority!.controllerGeneration
    const resets: string[] = []
    const events: boolean[] = []
    f.port.subscribeReset((_snapshot, reason) => {
      resets.push(reason)
    })
    f.port.subscribeEvents((_event, context) => {
      events.push(context.replay)
    })
    f.disconnect()
    await until(() => f.port.status === "disconnected")
    await expect(f.port.execute("turn.prompt", { message: "offline" })).rejects.toMatchObject({
      code: "disconnected",
    })
    // Detached runtime keeps processing its own work; use its retained frontend only to seed that work.
    const host = f.runtime.attach()
    await host.execute("turn.prompt", { message: "while detached" })
    await until(() => f.mock.requests.length === 1)
    await host.detach()
    await f.port.reconnect()
    await until(() => f.port.snapshot.transcript.messages.length >= 2)
    expect(f.port.authority!.controllerToken).toBe(token)
    expect(f.port.authority!.controllerGeneration).toBeGreaterThan(generation)
    expect(resets).toEqual([])
    expect(events).toContain(true)
    expect(f.attempts).toBe(2)
  } finally {
    await f.close()
  }
})

test("an uncertain command retries its original operation ID without duplicating host effects", async () => {
  let calls = 0
  let entered = false
  let finish!: () => void
  const release = new Promise<void>((resolve) => {
    finish = resolve
  })
  const f = await agentPortFixture({
    builtins: async () => [
      {
        source: "fixture",
        extension(api) {
          api.registerCommand({
            name: "slow",
            description: "fixture",
            async run() {
              calls++
              entered = true
              await release
            },
          })
        },
      },
    ],
  })
  try {
    const pending = f.port.execute("command.run", { line: "/slow" }, { operationId: "retained-command" })
    // Bun's rejection matcher waits immediately; disconnect before asserting the rejection.
    const rejected = pending.catch((error: unknown) => error)
    await until(() => entered)
    f.disconnect()
    expect(await rejected).toMatchObject({ code: "disconnected" })
    await f.port.reconnect()
    const retry = f.port.execute("command.run", { line: "/slow" }, { operationId: "retained-command" })
    finish()
    expect(await retry).toMatchObject({ ok: true })
    expect(calls).toBe(1)
    await expect(
      f.port.execute("command.run", { line: "/different" }, { operationId: "retained-command" }),
    ).rejects.toMatchObject({ code: "operation_conflict" })
  } finally {
    finish()
    await f.close()
  }
}, 15_000)

test("detach releases only this frontend, not runtime work or dialogs", async () => {
  const f = await agentPortFixture()
  try {
    await f.port.detach()
    expect(f.port.status).toBe("detached")
    expect(f.runtime.signal.aborted).toBe(false)
    await expect(f.port.reconnect()).rejects.toMatchObject({ code: "disconnected" })
    await f.waitForServerClose()
    const next = f.runtime.attach()
    expect(next.snapshot.state.sessionId).toBe(f.port.snapshot.state.sessionId)
    await next.detach()
  } finally {
    await f.close()
  }
})
