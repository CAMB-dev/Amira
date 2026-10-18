import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent, UiRequests } from "@amira/core"
import {
  createRpcDispatcher,
  createRpcOperations,
  type Handler,
  type RpcHandlers,
} from "../src/rpc/operations.ts"
import { type Id, type Params, RpcError } from "../src/rpc/validation.ts"
import { COMMAND_PARAMS } from "../src/rpc-schema.ts"

function dispatcher(overrides: Partial<RpcHandlers> = {}) {
  const replies: Record<string, unknown>[] = []
  const handlers = Object.fromEntries<Handler>(
    Object.keys(COMMAND_PARAMS).map((name) => [name, () => ({})]),
  ) as RpcHandlers
  Object.assign(handlers, overrides)
  const rpc = createRpcDispatcher({
    handlers,
    reply: (id, result) => void replies.push({ id, ok: true, ...result }),
    fail: (id, code, message) => void replies.push({ id, ok: false, error: { code, message } }),
  })
  const call = (cmd: string, id: Id = cmd, params: Params = {}) =>
    rpc.handle(JSON.stringify({ id, cmd, ...params }))
  return { ...rpc, call, replies }
}

const concurrent = ["command.run", "skill.run", "ui.action"] as const

for (const cmd of concurrent) {
  test(`dispatcher lets ui.respond overtake a pending ${cmd}`, async () => {
    const gate = Promise.withResolvers<void>()
    const rpc = dispatcher({
      [cmd]: async () => {
        await gate.promise
        return { finished: cmd }
      },
      "ui.respond": () => {
        gate.resolve()
        return { answered: true }
      },
    })
    try {
      await rpc.call(cmd, 1)
      expect(rpc.replies).toEqual([])
      await rpc.call("ui.respond", 2)
      await rpc.settle()
      expect(rpc.replies).toEqual([
        { id: 2, ok: true, answered: true },
        { id: 1, ok: true, finished: cmd },
      ])
    } finally {
      gate.resolve()
      await rpc.settle()
    }
  })

  test(`dispatcher drains a pending ${cmd} and reports its asynchronous failure`, async () => {
    const gate = Promise.withResolvers<void>()
    const rpc = dispatcher({
      [cmd]: async () => {
        await gate.promise
        throw new RpcError("command_failed", "cancelled")
      },
    })
    await rpc.call(cmd, 7)
    let settled = false
    const draining = rpc.settle().then(() => {
      settled = true
    })
    try {
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(rpc.replies).toEqual([])
      gate.resolve()
      await draining
      expect(rpc.replies).toEqual([
        { id: 7, ok: false, error: { code: "command_failed", message: "cancelled" } },
      ])
    } finally {
      gate.resolve()
      await draining
    }
  })
}

test("dispatcher keeps overlapping commands independent and replies in completion order", async () => {
  const gates = concurrent.map(() => Promise.withResolvers<void>())
  const handlers = Object.fromEntries<Handler>(
    concurrent.map((cmd, index) => [
      cmd,
      async () => {
        await gates[index]!.promise
        return { finished: cmd }
      },
    ]),
  )
  const rpc = dispatcher(handlers)
  try {
    for (const cmd of concurrent) await rpc.call(cmd)
    expect(rpc.replies).toEqual([])
    for (const gate of [...gates].reverse()) gate.resolve()
    await rpc.settle()
    expect(rpc.replies.map((reply) => reply.id)).toEqual([...concurrent].reverse())
  } finally {
    for (const gate of gates) gate.resolve()
    await rpc.settle()
  }
})

for (const cmd of ["session.resume", "command.complete"] as const) {
  test(`dispatcher preserves reader blocking for ${cmd}`, async () => {
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const rpc = dispatcher({
      [cmd]: async () => {
        started.resolve()
        await gate.promise
        return { finished: cmd }
      },
    })
    // This is the same awaited reader policy as runRpc, without process IO or lifecycle.
    const reading = (async () => {
      await rpc.call(cmd, 1)
      await rpc.call("state", 2)
    })()
    try {
      await started.promise
      expect(rpc.replies).toEqual([])
      gate.resolve()
      await reading
      expect(rpc.replies).toEqual([
        { id: 1, ok: true, finished: cmd },
        { id: 2, ok: true },
      ])
    } finally {
      gate.resolve()
      await reading
    }
  })
}

test("dispatcher sends a synchronous reply before queued command events", async () => {
  const order: string[] = []
  const rpc = dispatcher({
    prompt: (params) => {
      expect(params).toEqual({ id: "turn", cmd: "prompt", text: "hello", extra: true })
      queueMicrotask(() => order.push("event"))
      return { turnId: "injected-turn" }
    },
  })
  // handle runs synchronous handlers and replies before its returned promise is awaited.
  const handled = rpc.call("prompt", "turn", { text: "hello", extra: true })
  expect(rpc.replies).toEqual([{ id: "turn", ok: true, turnId: "injected-turn" }])
  expect(order).toEqual([])
  await handled
  expect(order).toEqual(["event"])
})

test("dispatcher keeps legacy validation, request IDs, and injected error mapping", async () => {
  const rpc = dispatcher({
    abort: () => {
      throw new RpcError("busy", "held")
    },
    state: () => {
      throw new Error("broken")
    },
  })
  await rpc.handle(" \t")
  expect(rpc.replies).toEqual([])
  await rpc.handle("{")
  expect(rpc.replies.pop()).toMatchObject({ id: null, error: { code: "parse_error" } })
  for (const input of ["null", "[]", '"command"', "3"]) {
    await rpc.handle(input)
    expect(rpc.replies.pop()).toEqual({
      id: null,
      ok: false,
      error: { code: "invalid_request", message: "a command must be a JSON object" },
    })
  }
  await rpc.handle('{"id":42}')
  expect(rpc.replies.pop()).toMatchObject({ id: 42, error: { code: "invalid_request" } })
  for (const cmd of ["unknown", "toString", "constructor", "__proto__"]) {
    await rpc.call(cmd, "bad")
    expect(rpc.replies.pop()).toEqual({
      id: "bad",
      ok: false,
      error: { code: "unknown_command", message: `unknown command "${cmd}"` },
    })
  }
  await rpc.call("abort", 0)
  expect(rpc.replies.pop()).toEqual({ id: 0, ok: false, error: { code: "busy", message: "held" } })
  await rpc.handle('{"id":{},"cmd":"state"}')
  expect(rpc.replies.pop()).toEqual({
    id: null,
    ok: false,
    error: { code: "internal", message: "broken" },
  })
})

test("operations use injected model lookup, turn IDs, resume authority and current agent", async () => {
  const ai = createAi({
    dialects: [createMockDialect([{ text: "first" }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const first = new Agent({ ai, model: ai.model("mock/first"), cwd: import.meta.dir, sessionId: "first" })
  const next = new Agent({ ai, model: ai.model("mock/next"), cwd: import.meta.dir, sessionId: "next" })
  let active = first
  const lookups: string[] = []
  const resumed: string[] = []
  const replaced: Agent[] = []
  const handlers = createRpcOperations({
    agent: () => active,
    ai: {
      model: (ref) => {
        lookups.push(ref)
        return ai.model(ref)
      },
    },
    ui: new UiRequests(first.bus),
    lastTurn: () => undefined,
    newTurnId: () => "injected-turn",
    resume: async (id) => {
      resumed.push(id)
      return id === "next" ? next : undefined
    },
    replaceAgent: async (agent) => {
      replaced.push(agent)
      active = agent
    },
  })
  try {
    expect(handlers["model.set"]({ model: "mock/selected" })).toEqual({ model: "mock/selected" })
    expect(lookups).toEqual(["mock/selected"])
    expect(handlers.prompt({ text: "hello" })).toEqual({ turnId: "injected-turn" })
    expect(first.turnId).toBe("injected-turn")
    await first.currentTurn
    await first.bus.flush()
    expect(first.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "first" }],
    })
    expect(await handlers["session.resume"]({ sessionId: "next" })).toEqual({ sessionId: "next" })
    expect(resumed).toEqual(["next"])
    expect(replaced).toEqual([next])
    expect(handlers.state({})).toMatchObject({ sessionId: "next", model: "mock/next", messages: 0 })
    await expect(handlers["session.resume"]({ sessionId: "absent" })).rejects.toMatchObject({
      code: "not_found",
      message: "no session absent",
    })
  } finally {
    await Promise.all([first.dispose("exit"), next.dispose("exit")])
  }
})
