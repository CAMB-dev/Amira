import { expect, spyOn, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, type AskOutcome, type AskRequest, defineTool, textResult } from "@amira/api"
import { ApprovalGate, type ApprovalTiming, approvalWaitMs } from "../src/agent/approvals.ts"
import { Agent, type ApprovalDecision, type Approver } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { Permissions } from "../src/permissions/policy.ts"
import { UiRequests } from "../src/ui-requests.ts"

function mockAi(steps: MockStep[] = []) {
  return createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
    retry: { retries: 0 },
  })
}

function setup(mixed = false) {
  const calls: MockStep = {
    toolCalls: ["a", "b"].map((id) => ({ id, name: "work", args: {} })),
  }
  const ai = mockAi([calls, { text: "done" }, calls, { text: "done again" }])
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  const events: AnyEvent[] = []
  const callbackStatuses: string[] = []
  const ran: string[] = []
  bus.subscribe((event) => void events.push(event))
  const agent: Agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    bus,
    approve: async (request, signal) => {
      callbackStatuses.push(agent.status)
      const answer = await ui.ask({ kind: "confirm", title: request.toolCallId }, { signal })
      return answer ? { approved: true, by: "user" } : { approved: false, reason: "not this call" }
    },
    ask: async (request, signal) => {
      callbackStatuses.push(agent.status)
      await ui.ask({ kind: "confirm", title: request.toolCallId ?? "question" }, { signal })
      return { unavailable: "interrupted" }
    },
  })
  agent.tools.register(
    defineTool({
      name: "work",
      description: "",
      parameters: { type: "object" },
      concurrency: "parallel",
      traits: { readOnly: true },
      execute: async (_args, ctx) => {
        ran.push(ctx.toolCallId)
        if (mixed && ctx.toolCallId === "b") await ctx.session!.askUser!([], ctx.signal)
        return textResult("done")
      },
    }),
    "test",
  )
  agent.interceptors.add("tool.call.before", (call) =>
    mixed && call.toolCallId === "b" ? { action: "pass" } : { action: "ask", reason: "check first" },
  )
  const until = (predicate: (event: AnyEvent) => boolean) => {
    if (events.some(predicate)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const off = bus.subscribe((event) => {
        if (!predicate(event)) return
        off()
        resolve()
      })
    })
  }
  return { agent, bus, ui, events, callbackStatuses, ran, until }
}

function statuses(events: AnyEvent[]) {
  return events.flatMap((event) =>
    event.type === "status.changed"
      ? [`${event.data.status}${event.data.pending === undefined ? "" : `:${event.data.pending}`}`]
      : [],
  )
}

function order(events: AnyEvent[]) {
  const requests = new Map<string, string>()
  return events.flatMap((event): string[] => {
    switch (event.type) {
      case "status.changed":
        return statuses([event])
      case "ui.request":
        requests.set(event.data.requestId, event.data.title)
        return [`request:${event.data.title}`]
      case "ui.resolved":
        return [`resolved:${requests.get(event.data.requestId)}`]
      case "tool.execute.start":
        return [`start:${event.data.toolCallId}`]
      case "tool.execute.end":
        return [`end:${event.data.toolCallId}`]
      case "turn.end":
        return ["turn.end"]
      default:
        return []
    }
  })
}

for (const mixed of [false, true]) {
  test(`abort with two parallel waits (${mixed ? "approval/question" : "approval/approval"})`, async () => {
    const { agent, bus, ui, events, callbackStatuses, ran, until } = setup(mixed)
    const turn = agent.prompt("go")
    await until((event) => event.type === "ui.request" && event.data.title === "b")
    await bus.flush()
    expect(ui.pending).toHaveLength(2)
    expect(callbackStatuses).toEqual(["blocked", "blocked"])
    expect(statuses(events)).toEqual(["working", "blocked:1", "blocked:2"])
    if (!mixed) {
      expect(order(events)).toEqual(["working", "blocked:1", "request:a", "blocked:2", "request:b"])
    }

    agent.abort()
    // UI cancellation is synchronous; wait cleanup must not briefly restore working.
    expect(ui.pending).toEqual([])
    expect((await turn).reason).toBe("aborted")
    await bus.flush()
    expect(statuses(events)).toEqual(["working", "blocked:1", "blocked:2", "idle"])
    expect(agent.status).toBe("idle")
    expect(ran).toEqual(mixed ? ["b"] : [])
    expect(events.filter((event) => event.type === "ui.resolved")).toHaveLength(2)
    expect(events.filter((event) => event.type === "turn.end")).toHaveLength(1)
    for (const id of ["a", "b"]) {
      expect(
        events.filter((event) => event.type === "tool.execute.start" && event.data.toolCallId === id),
      ).toHaveLength(1)
      expect(
        events.filter((event) => event.type === "tool.execute.end" && event.data.toolCallId === id),
      ).toHaveLength(1)
    }
    const endings = events.filter((event) => event.type === "tool.execute.end")
    for (const ending of endings) {
      if (mixed && ending.data.toolCallId === "b") expect(ending.data).not.toHaveProperty("waitedMs")
      else {
        expect(ending.data.waitedMs).toBeGreaterThanOrEqual(0)
        expect(ending.data.durationMs).toBe(0)
      }
    }
    const results = agent.messages.filter((message) => message.role === "toolResult")
    expect(results.map((message) => message.toolCallId)).toEqual(["a", "b"])
    const trace = order(events)
    expect(trace.indexOf("resolved:a")).toBeLessThan(trace.indexOf("start:a"))
    expect(trace.indexOf("resolved:b")).toBeLessThan(trace.indexOf("end:b"))
    expect(trace.slice(-2)).toEqual(["turn.end", "idle"])

    // A later turn starts its count at one, not at three or at a negative value.
    if (!mixed) {
      events.length = 0
      const next = agent.prompt("again")
      // The aborted first turn did not consume the next text-only model reply.
      await next
      await bus.flush()
      events.length = 0
      const tools = agent.prompt("tools again")
      await until((event) => event.type === "ui.request" && event.data.title === "b")
      expect(ui.pending).toHaveLength(2)
      for (const request of ui.pending) ui.respond(request.requestId, true)
      await tools
      await bus.flush()
      expect(statuses(events)).toEqual(["working", "blocked:1", "blocked:2", "working", "idle"])
      expect(agent.status).toBe("idle")
    }
  })
}

test("denying one pending call leaves the other blocked until it is allowed", async () => {
  const { agent, bus, ui, events, callbackStatuses, ran, until } = setup()
  const turn = agent.prompt("go")
  await until((event) => event.type === "ui.request" && event.data.title === "b")
  await bus.flush()
  expect(order(events)).toEqual(["working", "blocked:1", "request:a", "blocked:2", "request:b"])
  expect(callbackStatuses).toEqual(["blocked", "blocked"])
  const [first, second] = ui.pending
  ui.respond(first!.requestId, false)
  await until((event) => event.type === "tool.execute.end" && event.data.toolCallId === "a")
  await bus.flush()
  expect(agent.status).toBe("blocked")
  expect(ui.pending.map((request) => request.requestId)).toEqual([second!.requestId])
  expect(statuses(events)).toEqual(["working", "blocked:1", "blocked:2"])
  expect(ran).toEqual([])

  ui.respond(second!.requestId, true)
  expect((await turn).reason).toBe("done")
  await bus.flush()
  expect(order(events)).toEqual([
    "working",
    "blocked:1",
    "request:a",
    "blocked:2",
    "request:b",
    "resolved:a",
    "start:a",
    "end:a",
    "resolved:b",
    "working",
    "start:b",
    "end:b",
    "turn.end",
    "idle",
  ])
  expect(ran).toEqual(["b"])
  expect(ui.pending).toEqual([])
  expect(agent.status).toBe("idle")
  const results = agent.messages.filter((message) => message.role === "toolResult")
  expect(results.map((result) => result.toolCallId)).toEqual(["a", "b"])
  expect(results[0]).toMatchObject({ rejected: "blocked", isError: true })
  expect(results[0]!.content).toEqual([{ type: "text", text: "Tool call not approved: not this call" }])
  expect(results[1]).toMatchObject({ isError: false })
  const end = events.find((event) => event.type === "tool.execute.end" && event.data.toolCallId === "b")
  expect(end?.type === "tool.execute.end" && end.data.approval).toBe("user")
  const endings = events.filter((event) => event.type === "tool.execute.end")
  for (const ending of endings) expect(ending.data.waitedMs).toBeGreaterThanOrEqual(0)
  expect(endings[0]!.data.durationMs).toBe(0)
})

test("commander question forwarding keeps the request, signal and promise without blocking again", async () => {
  const request: AskRequest = { sessionId: "child", toolCallId: "call", questions: [] }
  const signal = new AbortController().signal
  const answer = Promise.withResolvers<AskOutcome>()
  const seen: [AskRequest, AbortSignal][] = []
  const receivers: Agent[] = []
  const ai = mockAi()
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    bus,
    ask: function (this: Agent, request, signal) {
      receivers.push(this)
      seen.push([request, signal])
      return answer.promise
    },
  })
  const forwarded = agent.askQuestions(request, signal)
  expect(forwarded).toBe(answer.promise)
  expect(seen).toHaveLength(1)
  expect(seen[0]![0]).toBe(request)
  expect(seen[0]![1]).toBe(signal)
  expect(receivers).toEqual([agent])
  expect(agent.status).toBe("idle")
  answer.resolve({ unavailable: "nobody can answer" })
  expect(await forwarded).toEqual({ unavailable: "nobody can answer" })
  await bus.flush()
  expect(events.filter((event) => event.type === "status.changed")).toEqual([])
})

test("commander forwarding preserves synchronous asker errors", () => {
  const ai = mockAi()
  const failure = new Error("cannot answer")
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    ask: () => {
      throw failure
    },
  })
  expect(() =>
    agent.askQuestions({ sessionId: "child", questions: [] }, new AbortController().signal),
  ).toThrow(failure)
  expect(agent.status).toBe("idle")
})

for (const available of [true, false]) {
  test(`permission approval honors the public getter override (${available ? "approver" : "undefined"})`, async () => {
    let asked = 0
    let fallback = 0
    let ran = 0
    const ai = mockAi([{ toolCalls: [{ id: "call", name: "unknown", args: {} }] }, { text: "done" }])
    class CustomAgent extends Agent {
      override get permissionApprover(): Approver | undefined {
        return available
          ? async () => {
              asked++
              return { approved: true }
            }
          : undefined
      }
    }
    const bus = new EventBus()
    const events: AnyEvent[] = []
    bus.subscribe((event) => void events.push(event))
    const agent = new CustomAgent({
      ai,
      bus,
      model: ai.model("mock/test"),
      cwd: process.cwd(),
      permissions: new Permissions({
        mode: "plan",
        approver: async () => {
          fallback++
          return { approved: true }
        },
      }),
    })
    agent.tools.register(
      defineTool({
        name: "unknown",
        description: "",
        parameters: { type: "object" },
        execute: async () => {
          ran++
          return textResult("done")
        },
      }),
      "test",
    )
    await agent.prompt("go")
    await bus.flush()
    const end = events.find((event) => event.type === "tool.execute.end")
    if (available) expect(end?.data.waitedMs).toBeGreaterThanOrEqual(0)
    else expect(end?.data).not.toHaveProperty("waitedMs")
    expect(asked).toBe(available ? 1 : 0)
    expect(ran).toBe(available ? 1 : 0)
    expect(fallback).toBe(0)
    const result = agent.messages.find((message) => message.role === "toolResult")
    expect(result?.isError).toBe(!available)
    if (!available) expect(result).toMatchObject({ rejected: "blocked" })
  })
}

test("the gate invokes callbacks synchronously and preserves blocked-wait microtasks", async () => {
  const trace: string[] = []
  const answer = Promise.withResolvers<ApprovalDecision>()
  const turn = { id: "turn", signal: new AbortController().signal }
  const gate = new ApprovalGate({
    sessionId: "session",
    depth: 0,
    permissions: new Permissions(),
    inheritedApprover: undefined,
    resolvePermissionApprover: () => undefined,
    ask: undefined,
    forwardAsk: undefined,
    approve: () => {
      trace.push("callback")
      return answer.promise
    },
    isCurrentTurn: (candidate) => candidate === turn,
    blocked: (_turn, _reason, pending) => void trace.push(`blocked:${pending}`),
    working: () => void trace.push("working"),
  })
  const timing: ApprovalTiming = {}
  const verdict = gate.approve(
    turn,
    { id: "call", name: "work", args: {} },
    { decision: "allow", reason: "" },
    ["check first"],
    timing,
  )
  expect(timing.startedAt).toBeNumber()
  expect(timing.endedAt).toBeUndefined()
  expect(trace).toEqual(["blocked:1", "callback"])
  answer.resolve({ approved: true })
  trace.push("settled")
  queueMicrotask(() => {
    trace.push("microtask:1")
    queueMicrotask(() => {
      trace.push("microtask:2")
      queueMicrotask(() => trace.push("microtask:3"))
    })
  })
  await verdict.then(() => trace.push("verdict"))
  expect(timing.endedAt).toBeNumber()
  expect(approvalWaitMs(timing)).toBe(Math.round(timing.endedAt! - timing.startedAt!))
  expect(trace).toEqual([
    "blocked:1",
    "callback",
    "settled",
    "working",
    "microtask:1",
    "microtask:2",
    "verdict",
    "microtask:3",
  ])
})

test("a wait abandoned by an aborted turn stays out of the next turn's count", async () => {
  const trace: string[] = []
  const first = new AbortController()
  const turn1 = { id: "turn1", signal: first.signal }
  const turn2 = { id: "turn2", signal: new AbortController().signal }
  let current = turn1
  const never = new Promise<ApprovalDecision>(() => {})
  const answer = Promise.withResolvers<ApprovalDecision>()
  let calls = 0
  const gate = new ApprovalGate({
    sessionId: "session",
    depth: 0,
    permissions: new Permissions(),
    inheritedApprover: undefined,
    resolvePermissionApprover: () => undefined,
    ask: undefined,
    forwardAsk: undefined,
    // The first approver ignores abort and never settles.
    approve: () => (calls++ === 0 ? never : answer.promise),
    isCurrentTurn: (candidate) => candidate === current,
    blocked: (turn, _reason, pending) => void trace.push(`${turn.id} blocked:${pending}`),
    working: (turn) => void trace.push(`${turn.id} working`),
  })
  const call = { id: "call", name: "work", args: {} }
  void gate.approve(turn1, call, { decision: "allow", reason: "" }, ["check first"])
  first.abort()
  current = turn2
  const verdict = gate.approve(turn2, call, { decision: "allow", reason: "" }, ["check first"])
  answer.resolve({ approved: true })
  await verdict
  expect(trace).toEqual(["turn1 blocked:1", "turn2 blocked:1", "turn2 working"])
})

test("a late wait of an ended turn does not hide the current turn's wait", async () => {
  const trace: string[] = []
  const turn1 = { id: "turn1", signal: new AbortController().signal }
  const turn2 = { id: "turn2", signal: new AbortController().signal }
  const answers = [Promise.withResolvers<ApprovalDecision>(), Promise.withResolvers<ApprovalDecision>()]
  let calls = 0
  const gate = new ApprovalGate({
    sessionId: "session",
    depth: 0,
    permissions: new Permissions(),
    inheritedApprover: undefined,
    resolvePermissionApprover: () => undefined,
    ask: undefined,
    forwardAsk: undefined,
    approve: () => answers[calls++]!.promise,
    isCurrentTurn: (candidate) => candidate === turn2,
    blocked: (turn, _reason, pending) => void trace.push(`${turn.id} blocked:${pending}`),
    working: (turn) => void trace.push(`${turn.id} working`),
  })
  const call = { id: "call", name: "work", args: {} }
  const current = gate.approve(turn2, call, { decision: "allow", reason: "" }, ["check"])
  const late = gate.approve(turn1, call, { decision: "allow", reason: "" }, ["check"])
  answers[0]!.resolve({ approved: true })
  await current
  answers[1]!.resolve({ approved: true })
  await late
  expect(trace).toEqual(["turn2 blocked:1", "turn2 working"])
})

test("approval timing preserves zero and does not invent a wait", () => {
  expect(approvalWaitMs(undefined)).toBeUndefined()
  expect(approvalWaitMs({})).toBeUndefined()
  expect(approvalWaitMs({ startedAt: 10, endedAt: 10 })).toBe(0)
  expect(approvalWaitMs({ startedAt: 10, endedAt: 25 })).toBe(15)
})

test("approval timing belongs to each call even with duplicate parallel IDs", async () => {
  const ai = mockAi([
    {
      toolCalls: ["approved", "denied", "invalid", "plain", "failed"].map((kind) => ({
        id: "reused",
        name: "work",
        args: { kind, ...(kind === "invalid" ? {} : { value: 1 }) },
      })),
    },
    { text: "done" },
  ])
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const agent = new Agent({
    ai,
    bus,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    approve: async (request) => {
      await Bun.sleep(10)
      if (request.args.kind === "failed") throw new Error("approver failed")
      return request.args.kind === "denied" ? { approved: false } : { approved: true, by: "user" }
    },
  })
  agent.tools.register(
    defineTool({
      name: "work",
      description: "",
      parameters: {
        type: "object",
        properties: { kind: { type: "string" }, value: { type: "number" } },
        required: ["value"],
      },
      concurrency: "parallel",
      traits: { readOnly: true },
      execute: async (args) => textResult(String(args.kind)),
    }),
    "test",
  )
  agent.interceptors.add("tool.call.before", (call) =>
    call.args.kind === "plain" ? { action: "pass" } : { action: "ask", reason: "check" },
  )
  await agent.prompt("go")
  await bus.flush()
  const endings = events.filter((event) => event.type === "tool.execute.end")
  expect(endings).toHaveLength(5)
  const plain = endings.find((event) =>
    event.data.result.content.some((b) => b.type === "text" && b.text === "plain"),
  )!
  expect(plain.data).not.toHaveProperty("waitedMs")
  for (const event of endings.filter((ending) => ending !== plain)) {
    expect(event.data.waitedMs).toBeGreaterThanOrEqual(0)
    if (event.data.rejected) expect(event.data.durationMs).toBe(0)
  }
  expect(endings.filter((event) => event.data.rejected === "blocked")).toHaveLength(2)
  expect(endings.filter((event) => event.data.rejected === "invalidArgs")).toHaveLength(1)
  expect(endings.filter((event) => event.data.approval === "user")).toHaveLength(2)
})

test("tool duration measures execution without approval or interceptor time", async () => {
  let clock = 0
  const now = spyOn(performance, "now").mockImplementation(() => clock)
  const ai = mockAi([{ toolCalls: [{ id: "call", name: "work", args: {} }] }, { text: "done" }])
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const agent = new Agent({
    ai,
    bus,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    approve: async () => {
      clock += 250
      return { approved: true, by: "user" }
    },
  })
  agent.tools.register(
    defineTool({
      name: "work",
      description: "",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async () => {
        clock += 25
        return textResult("done")
      },
    }),
    "test",
  )
  agent.interceptors.add("tool.call.before", () => {
    clock += 100
    return { action: "ask", reason: "check" }
  })
  agent.interceptors.add("tool.call.after", () => {
    clock += 200
    return { action: "pass" }
  })
  try {
    await agent.prompt("go")
    await bus.flush()
    const end = events.find((event) => event.type === "tool.execute.end")!
    expect(end.data.waitedMs).toBe(250)
    expect(end.data.durationMs).toBe(25)
  } finally {
    now.mockRestore()
    await agent.dispose()
  }
})

test("a policy denial does not report approval waiting", async () => {
  const ai = mockAi([{ toolCalls: [{ id: "call", name: "write", args: {} }] }, { text: "done" }])
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const agent = new Agent({
    ai,
    bus,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    permissions: new Permissions({ mode: "plan" }),
    approve: async () => {
      throw new Error("must not ask")
    },
  })
  agent.tools.register(
    defineTool({
      name: "write",
      description: "",
      parameters: { type: "object" },
      traits: { writesFiles: true },
      execute: async () => textResult("must not run"),
    }),
    "test",
  )
  await agent.prompt("go")
  await bus.flush()
  const end = events.find((event) => event.type === "tool.execute.end")!
  expect(end.data.rejected).toBe("blocked")
  expect(end.data.durationMs).toBe(0)
  expect(end.data).not.toHaveProperty("waitedMs")
})

test("abandoning an approver that ignores abort snapshots its unfinished wait", async () => {
  const ai = mockAi([{ toolCalls: [{ id: "call", name: "work", args: {} }] }])
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const entered = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<ApprovalDecision>()
  const agent = new Agent({
    ai,
    bus,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    abortGraceMs: 1,
    approve: () => {
      entered.resolve()
      return answer.promise
    },
  })
  agent.tools.register(
    defineTool({
      name: "work",
      description: "",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async () => textResult("must not run"),
    }),
    "test",
  )
  agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "check" }))
  const turn = agent.prompt("go")
  await entered.promise
  agent.abort()
  expect((await turn).reason).toBe("aborted")
  await bus.flush()
  const end = events.find((event) => event.type === "tool.execute.end")!
  expect(end.data.rejected).toBe("aborted")
  expect(end.data.durationMs).toBe(0)
  expect(end.data.waitedMs).toBeGreaterThanOrEqual(0)
  const waitedMs = end.data.waitedMs
  answer.resolve({ approved: true })
  await Bun.sleep(0)
  await bus.flush()
  expect(end.data.waitedMs).toBe(waitedMs)
  expect(events.filter((event) => event.type === "tool.execute.end")).toHaveLength(1)
})
