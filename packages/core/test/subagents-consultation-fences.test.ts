import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  createAi,
  createMockDialect,
  emptyUsage,
  type StreamEvent,
} from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { accountingRecorded, unfinishedAccounting } from "../src/accounting-requests.ts"
import { Agent } from "../src/agent.ts"
import { conversationUsage, recordConversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { ParentConsultant } from "../src/subagents/consult-parent.ts"
import { accountedConsultation } from "../src/subagents/consultation-accounting.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const aborted: StreamEvent = {
  type: "error",
  error: { message: "aborted without usage", code: "aborted" },
  retryable: false,
  message: {
    role: "assistant",
    model: { provider: "mock", model: "commander" },
    content: [],
    stopReason: "aborted",
  },
}

function fixture(owned: boolean, consultation: () => AsyncIterable<StreamEvent>, nested = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "amira-consult-fence-"))
  const mock = createMockDialect([
    ...(nested ? [{ toolCalls: [{ name: "launch", args: {} }], usage: { cost: 1 } }] : []),
    { toolCalls: [{ name: "read", args: {} }], usage: { input: 2, cost: 0.2 } },
    { text: "done", usage: { cost: 0 } },
    ...(nested ? [{ text: "done", usage: { cost: 0 } }] : []),
  ])
  const base = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const ai: Ai = {
    ...base,
    stream: (request, signal) =>
      request.model.id === "commander" || (request.model.id === "leader" && request.tools.length === 0)
        ? consultation()
        : base.stream(request, signal),
  }
  const host = new AgentTree({ ai, sections: () => [] })
  const tree = owned ? new AgentTree({ ai, shared: host, sections: () => [] }) : host
  const store = SessionStore.create({
    cwd: directory,
    dir: directory,
    ...(owned
      ? {
          owned: {
            v: 1 as const,
            owner: "test",
            spec: {
              key: "test",
              name: "Test",
              cwd: directory,
              model: "mock/commander",
              systemPrompt: "",
              callableTools: ["read"],
            },
            runtimeTools: [],
          },
        }
      : {}),
  })
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
    cwd: directory,
    session: store,
    tools,
    tree,
    sections: [],
    ...(owned ? { ownedConversation: "test" } : {}),
  })
  parent.interceptors.add("tool.call.before", (event) =>
    event.name === "read" ? { action: "ask", reason: "review" } : { action: "pass" },
  )
  return {
    ai,
    tree,
    parent,
    store,
    async dispose() {
      await parent.dispose()
      tree.releaseScope()
      host.releaseScope()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

for (const owned of [false, true]) {
  test(`${owned ? "owned" : "ordinary"} private consultation without usage retains unknown coverage live and after restart`, async () => {
    const f = fixture(owned, async function* () {
      yield aborted
    })
    const group = f.tree.createGroup(f.parent, { name: "private work" })
    try {
      const child = group.spawn({
        prompt: "private",
        model: "mock/worker",
        callableTools: ["read"],
        ephemeral: true,
        maxTurns: 1,
      })
      await child.result()
      await f.tree.waitForChildren()
      expect(f.tree.usage.cost).toBe(0.2)
      expect(group.info().usage.cost).toBe(0.2)
      expect(conversationUsage(f.parent).own).toMatchObject({ knownCostUsd: 0, complete: true })
      for (const source of [f.parent, SessionStore.open(f.store.file)]) {
        const snapshot = conversationUsage(source)
        expect(snapshot.total).toMatchObject({ knownCostUsd: 0.2, complete: false })
        expect(snapshot.descendants).toMatchObject([
          { sessionId: child.id, groupId: group.id, ephemeral: true, usage: { complete: false } },
        ])
      }
      expect(unfinishedAccounting(f.store)).toMatchObject([
        { attribution: { sessionId: child.id, groupId: group.id, ephemeral: true } },
      ])
    } finally {
      await f.dispose()
    }
  })
}

test("owned private consultation stays incomplete while outstanding and after its requester has ended", async () => {
  const opened = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const drained = Promise.withResolvers<void>()
  const f = fixture(true, async function* () {
    opened.resolve()
    try {
      await release.promise
      yield aborted
    } finally {
      drained.resolve()
    }
  })
  const child = f.tree.spawn(f.parent, {
    prompt: "private",
    model: "mock/worker",
    callableTools: ["read"],
    ephemeral: true,
    maxTurns: 1,
  })
  try {
    await opened.promise
    child.abort("requester ends before consultation cleanup")
    expect((await child.result()).status).toBe("aborted")
    for (const source of [f.parent, SessionStore.open(f.store.file)]) {
      expect(conversationUsage(source).total).toMatchObject({ knownCostUsd: 0.2, complete: false })
    }
    release.resolve()
    await drained.promise
    // Let the physical stream's nested finally blocks release admission and settle accounting.
    await Bun.sleep(0)
    for (const source of [f.parent, SessionStore.open(f.store.file)]) {
      const snapshot = conversationUsage(source)
      expect(snapshot.total).toMatchObject({ knownCostUsd: 0.2, complete: false })
      expect(snapshot.own).toMatchObject({ knownCostUsd: 0, complete: true })
      expect(snapshot.descendants[0]).toMatchObject({ sessionId: child.id, usage: { complete: false } })
    }
  } finally {
    release.resolve()
    await drained.promise
    await Bun.sleep(0)
    await f.dispose()
  }
})

for (const owned of [false, true]) {
  test(`${owned ? "owned" : "ordinary"} nonprivate child consultation fences its root owner's session`, async () => {
    const f = fixture(owned, async function* () {
      yield aborted
    })
    try {
      const child = f.tree.spawn(f.parent, {
        prompt: "public worker",
        model: "mock/worker",
        callableTools: ["read"],
        maxTurns: 1,
      })
      await child.result()
      await f.tree.waitForChildren()
      for (const source of [f.parent, SessionStore.open(f.store.file)]) {
        const snapshot = conversationUsage(source)
        expect(snapshot.total).toMatchObject({ knownCostUsd: 0.2, complete: false })
        expect(snapshot.own).toMatchObject({ knownCostUsd: 0, complete: false })
        expect(snapshot.descendants[0]).toMatchObject({ sessionId: child.id, usage: { complete: true } })
      }
      expect(unfinishedAccounting(f.store)).toEqual([{ attribution: undefined }])
    } finally {
      await f.dispose()
    }
  })
}

for (const owned of [false, true]) {
  test(`${owned ? "owned" : "ordinary"} nested private consultation keeps the leaf's attribution`, async () => {
    const f = fixture(
      owned,
      async function* () {
        yield aborted
      },
      true,
    )
    let leafId: string | undefined
    f.parent.tools.register(
      defineTool({
        name: "launch",
        description: "launch nested work",
        parameters: {},
        execute: async (_args, context) => {
          const leaf = context.session!.spawn!({
            prompt: "private leaf",
            model: "mock/worker",
            callableTools: ["read"],
            ephemeral: true,
            maxTurns: 1,
          })
          leafId = leaf.id
          await leaf.result()
          return textResult("nested work done")
        },
      }),
      "test",
    )
    try {
      const leader = f.tree.spawn(f.parent, {
        prompt: "private leader",
        model: "mock/leader",
        callableTools: ["launch", "read"],
        ephemeral: true,
        maxTurns: 1,
      })
      expect((await leader.result()).status).toBe("done")
      await f.tree.waitForChildren()
      expect(leafId).toBeDefined()
      for (const source of [f.parent, SessionStore.open(f.store.file)]) {
        const snapshot = conversationUsage(source)
        expect(snapshot.total.knownCostUsd).toBeCloseTo(1.2)
        expect(snapshot.total.complete).toBe(false)
        expect(snapshot.own).toMatchObject({ knownCostUsd: 0, complete: true })
        expect(snapshot.descendants.find((child) => child.sessionId === leafId)).toMatchObject({
          parentSessionId: leader.id,
          ephemeral: true,
          usage: { knownCostUsd: 0.2, complete: false },
        })
        expect(snapshot.descendants.find((child) => child.sessionId === leader.id)).toMatchObject({
          parentSessionId: f.parent.sessionId,
          ephemeral: true,
          usage: { knownCostUsd: 1, complete: true },
        })
      }
      expect(unfinishedAccounting(f.store)).toMatchObject([
        { attribution: { sessionId: leafId, parentSessionId: leader.id, ephemeral: true } },
      ])
    } finally {
      await f.dispose()
    }
  })
}

const priced: AssistantMessage = {
  role: "assistant",
  model: { provider: "mock", model: "commander" },
  content: [{ type: "text", text: "APPROVE" }],
  usage: { ...emptyUsage(), input: 3, cost: 0.3 },
}

for (const boundary of [
  "synthetic backoff abort",
  "actual retry abort",
  "unreported first attempt",
  "reported retry",
] as const) {
  test(`consultation coverage distinguishes ${boundary} without changing its known subtotal`, async () => {
    const retry: StreamEvent = {
      type: "retry",
      attempt: 1,
      maxRetries: 1,
      delayMs: 0,
      error: { message: "temporary failure" },
    }
    const f = fixture(true, async function* () {
      yield { type: "request.start" }
      yield {
        type: "request.end",
        message: boundary === "unreported first attempt" ? aborted.message : priced,
      }
      yield retry
      if (boundary !== "synthetic backoff abort") yield { type: "request.start" }
      yield boundary === "reported retry" || boundary === "unreported first attempt"
        ? { type: "done", message: priced }
        : aborted
    })
    try {
      const child = f.tree.spawn(f.parent, {
        prompt: "private",
        model: "mock/worker",
        callableTools: ["read"],
        ephemeral: true,
        maxTurns: 1,
      })
      await child.result()
      await f.tree.waitForChildren()
      const complete = boundary === "synthetic backoff abort" || boundary === "reported retry"
      const knownCostUsd = boundary === "reported retry" ? 0.8 : 0.5
      expect(f.tree.usage.cost).toBeCloseTo(knownCostUsd)
      for (const source of [f.parent, SessionStore.open(f.store.file)]) {
        const snapshot = conversationUsage(source)
        expect(snapshot.total.knownCostUsd).toBeCloseTo(knownCostUsd)
        expect(snapshot.total.complete).toBe(complete)
        expect(snapshot.own.complete).toBe(true)
        expect(snapshot.descendants[0]?.usage.complete).toBe(complete)
      }
      expect(unfinishedAccounting(f.store)).toHaveLength(complete ? 0 : 1)
    } finally {
      await f.dispose()
    }
  })
}

for (const fallback of [false, true]) {
  for (const startOnly of [false, true]) {
    test(`an admitted ${fallback ? "standard fallback" : "retry"} with ${startOnly ? "only start" : "no events"} remains unknown`, async () => {
      let dispatches = 0
      const first = createMockDialect([
        {
          error: {
            message: fallback ? "priority capacity unavailable" : "retry",
            retryable: true,
            status: fallback ? 429 : 503,
          },
          usage: { input: 2, output: 1, cost: 0.2 },
        },
      ])
      const commander = createAi({
        dialects: [
          {
            ...first,
            id: "openai-chat",
            async *stream(request, context) {
              dispatches++
              if (dispatches === 1) yield* first.stream(request, context)
              else if (startOnly) yield { type: "start" }
            },
          },
        ],
        providers: [
          {
            id: "mock",
            dialect: "openai-chat",
            baseUrl: "https://provider.invalid",
            defaultModel: { fast: { kind: "service-tier", value: "priority" } },
          },
        ],
        retry: { retries: 1, baseDelayMs: 0 },
      })
      const f = fixture(true, () =>
        commander.stream({
          model: commander.model("mock/commander"),
          systemPrompt: "",
          messages: [],
          tools: [],
          fastMode: fallback,
        }),
      )
      try {
        const child = f.tree.spawn(f.parent, {
          prompt: "work",
          title: "private worker",
          model: "mock/worker",
          ephemeral: true,
          maxTurns: 1,
          callableTools: ["read"],
        })
        await child.result()
        await f.tree.waitForChildren()
        expect(dispatches).toBe(2)
        for (const source of [f.parent, SessionStore.open(f.store.file)]) {
          const snapshot = conversationUsage(source)
          expect(snapshot.total.knownCostUsd).toBeCloseTo(0.4)
          expect(snapshot.total.complete).toBe(false)
        }
      } finally {
        await f.dispose()
      }
    })
  }
}

test("an admission waiter aborted before physical dispatch leaves no consultation fence", async () => {
  const waiting = Promise.withResolvers<void>()
  const permit = Promise.withResolvers<void>()
  let dispatches = 0
  const f = fixture(false, async function* () {
    dispatches++
    yield aborted
  })
  f.store.append({ type: "display", text: "seed durable session", level: "info" })
  const controller = new AbortController()
  let releases = 0
  const consultant = new ParentConsultant({
    ai: f.ai,
    callableTools: () => undefined,
    usageRecorder: (owner) =>
      accountedConsultation(owner, (usage) => {
        recordConversationUsage(owner, usage)
        accountingRecorded(owner, usage)
      }),
    acquire: async () => {
      waiting.resolve()
      await permit.promise
      return () => releases++
    },
  })
  try {
    const consultation = consultant.approve(
      f.parent,
      {
        sessionId: "waiting-child",
        toolCallId: "read-1",
        name: "read",
        args: {},
        reason: "review",
      },
      controller.signal,
    )
    await waiting.promise
    expect(unfinishedAccounting(f.store)).toHaveLength(0)
    expect(conversationUsage(f.parent).total.complete).toBe(true)
    controller.abort()
    permit.resolve()
    await consultation
    await Bun.sleep(0)
    expect(releases).toBe(1)
    expect(dispatches).toBe(0)
    expect(unfinishedAccounting(f.store)).toHaveLength(0)
    expect(conversationUsage(SessionStore.open(f.store.file)).total.complete).toBe(true)
  } finally {
    controller.abort()
    permit.resolve()
    await Bun.sleep(0)
    await f.dispose()
  }
})
