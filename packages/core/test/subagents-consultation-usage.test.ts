import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type Ai, createAi, createMockDialect } from "@amira/ai"
import { type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("aborting a consultation during backoff books one $2 attempt exactly once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-abort-consultation-cost-"))
  const mock = createMockDialect([
    { toolCalls: [{ name: "read", args: {} }], usage: { cost: 0 } },
    { error: { message: "temporary failure", retryable: true }, usage: { cost: 2 } },
  ])
  const base = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 1, baseDelayMs: 1000 },
  })
  let child: ChildSession
  const consultationEnded = Promise.withResolvers<void>()
  const ai: Ai = {
    ...base,
    async *stream(request, signal) {
      let consultation = false
      try {
        for await (const event of base.stream(request, signal)) {
          yield event
          if (event.type === "retry") {
            consultation = true
            child.abort("abort during retry backoff")
          }
        }
      } finally {
        if (consultation) consultationEnded.resolve()
      }
    },
  }
  const tree = new AgentTree({ ai, sections: () => [] })
  const store = SessionStore.create({ cwd: dir, dir })
  const tools = new ToolRegistry()
  tools.register(
    defineTool({
      name: "read",
      description: "read",
      parameters: {},
      execute: async () => textResult("ok"),
    }),
    "test",
  )
  const parent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    session: store,
    tools,
    tree,
    sections: [],
  })
  parent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval needed" }))
  try {
    child = tree.spawn(parent, { prompt: "private", ephemeral: true, callableTools: ["read"], maxTurns: 1 })
    const result = await child.result()
    await consultationEnded.promise
    expect(mock.requests).toHaveLength(2)
    expect(result.status).toBe("aborted")
    expect(result.usage.cost).toBe(2)
    expect(tree.usage.cost).toBe(2)
    const charges = store.entries
      .filter((entry) => entry.type === "side_usage")
      .map((entry) => entry.usage.cost)
    expect(charges.filter((cost) => cost === 2)).toEqual([2])
    expect(charges.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)).toBe(2)
    store.append({ type: "display", text: "flush buffered session usage", level: "info" })
    expect(
      SessionStore.open(store.file)
        .entries.filter((entry) => entry.type === "side_usage")
        .map((entry) => entry.usage.cost),
    ).toEqual(charges)
  } finally {
    await parent.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("late aborted consultation usage stays with its ended ephemeral child and group", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-late-consultation-cost-"))
  const opened = Promise.withResolvers<void>()
  const terminalReady = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const charged = Promise.withResolvers<void>()
  const mock = createMockDialect([
    { toolCalls: [{ name: "read", args: {} }], usage: { cost: 1 } },
    { text: "APPROVE", usage: { cost: 3 }, delayMs: 10_000 },
  ])
  const ai = createAi({
    dialects: [
      {
        ...mock,
        async *stream(request, context) {
          const consultation = request.tools.length === 0
          if (consultation) opened.resolve()
          for await (const event of mock.stream(request, context)) {
            if (consultation && event.type === "error" && event.error.code === "aborted") {
              terminalReady.resolve()
              await release.promise
            }
            yield event
          }
        },
      },
    ],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const store = SessionStore.create({ cwd: dir, dir })
  const tools = new ToolRegistry()
  tools.register(
    defineTool({
      name: "read",
      description: "read",
      parameters: {},
      execute: async () => textResult("ok"),
    }),
    "test",
  )
  const parent = new Agent({
    ai,
    model: ai.model("mock/commander"),
    cwd: dir,
    session: store,
    tools,
    tree,
    sections: [],
  })
  parent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval needed" }))
  const stop = parent.bus.subscribe((event) => {
    if (event.type === "budget.update" && event.data.costUsd === 4) charged.resolve()
  })
  const group = tree.createGroup(parent, { name: "private work" })
  try {
    const child = group.spawn({
      prompt: "private",
      model: "mock/worker",
      ephemeral: true,
      callableTools: ["read"],
      maxTurns: 1,
    })
    await opened.promise
    child.abort("abort while the commander is answering")
    await terminalReady.promise
    const result = await child.result()
    expect(result.status).toBe("aborted")
    expect(result.usage.cost).toBe(1)
    expect(tree.usage.cost).toBe(1)
    expect(group.info().usage.cost).toBe(1)
    expect(group.info().agents.ended).toBe(1)
    release.resolve()
    await charged.promise
    expect(mock.requests).toHaveLength(2)
    expect(tree.usage.cost).toBe(4)
    expect(group.info().usage.cost).toBe(4)
    const charges = store.entries.filter((entry) => entry.type === "side_usage")
    expect(charges.map((entry) => entry.usage.cost)).toEqual([1, 3])
    expect(charges.map((entry) => entry.model)).toEqual([
      { provider: "mock", model: "worker" },
      { provider: "mock", model: "commander" },
    ])
    store.append({ type: "display", text: "flush late consultation usage", level: "info" })
    expect(SessionStore.open(store.file).entries.filter((entry) => entry.type === "side_usage")).toEqual(
      charges,
    )
  } finally {
    release.resolve()
    stop()
    await parent.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const retries of [0, 1]) {
  test(`ephemeral consultations persist failed attempts with ${retries} retries exactly once`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-consultation-cost-"))
    const mock = createMockDialect([
      { toolCalls: [{ name: "read", args: {} }], usage: { cost: 1 } },
      { error: { message: "temporary failure", retryable: true }, usage: { cost: 2 } },
      ...(retries ? [{ text: "APPROVE", usage: { cost: 3 } }] : []),
      { text: "done", usage: { cost: 4 } },
    ])
    const ai = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries, baseDelayMs: 0 },
    })
    const tree = new AgentTree({ ai, sections: () => [] })
    const store = SessionStore.create({ cwd: dir, dir })
    const tools = new ToolRegistry()
    tools.register(
      defineTool({
        name: "read",
        description: "read",
        parameters: {},
        execute: async () => textResult("ok"),
      }),
      "test",
    )
    const parent = new Agent({
      ai,
      model: ai.model("mock/m"),
      cwd: dir,
      session: store,
      tools,
      tree,
      sections: [],
    })
    parent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval needed" }))
    try {
      const child = tree.spawn(parent, {
        prompt: "private",
        ephemeral: true,
        callableTools: ["read"],
        maxTurns: 1,
      })
      const result = await child.result()
      const expected = retries ? 10 : 7
      expect(result.status).toBe("done")
      expect(result.usage.cost).toBe(expected)
      expect(tree.usage.cost).toBe(expected)
      const usage = store.entries.filter((entry) => entry.type === "side_usage")
      expect(usage.map((entry) => entry.usage.cost)).toEqual(retries ? [1, 2, 3, 4] : [1, 2, 4])
      expect(usage.reduce((sum, entry) => sum + (entry.usage.cost ?? 0), 0)).toBe(expected)
    } finally {
      await parent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
