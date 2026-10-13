import { expect, test } from "bun:test"
import {
  type Ai,
  type AssistantMessage,
  createAi,
  createMockDialect,
  emptyUsage,
  type StreamEvent,
} from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { ParentConsultant } from "../src/subagents/consult-parent.ts"

function message(cost: number): AssistantMessage {
  return {
    role: "assistant",
    model: { provider: "mock", model: "m" },
    content: [],
    usage: { ...emptyUsage(), cost },
  }
}

const cases: {
  name: string
  costs: number[]
  succeeds: boolean
  stream: (text: string) => AsyncIterable<StreamEvent>
}[] = [
  {
    name: "uses the updated final usage on the same message",
    costs: [3],
    succeeds: true,
    async *stream(text) {
      const reply = message(2)
      yield { type: "request.start" }
      yield { type: "request.end", message: reply }
      reply.usage = { ...emptyUsage(), cost: 3 }
      reply.content = [{ type: "text", text }]
      yield { type: "done", message: reply }
    },
  },
  {
    name: "counts separate requests even when the message identity is reused",
    costs: [2, 3],
    succeeds: true,
    async *stream(text) {
      const reply = message(2)
      yield { type: "request.start" }
      yield { type: "request.end", message: reply }
      yield { type: "retry", attempt: 1, maxRetries: 1, delayMs: 0, error: { message: "temporary failure" } }
      yield { type: "request.start" }
      reply.usage = { ...emptyUsage(), cost: 3 }
      reply.content = [{ type: "text", text }]
      yield { type: "done", message: reply }
    },
  },
  {
    name: "uses updated abort usage once without starting another request",
    costs: [3],
    succeeds: false,
    async *stream() {
      const reply = message(2)
      yield { type: "request.start" }
      yield { type: "request.end", message: reply }
      yield {
        type: "retry",
        attempt: 1,
        maxRetries: 1,
        delayMs: 1000,
        error: { message: "temporary failure" },
      }
      yield {
        type: "error",
        error: { message: "aborted", code: "aborted" },
        retryable: false,
        message: { ...reply, stopReason: "aborted", usage: { ...emptyUsage(), cost: 3 } },
      }
    },
  },
  {
    name: "counts an abort after a new retry request has actually started",
    costs: [2, 3],
    succeeds: false,
    async *stream() {
      yield { type: "request.start" }
      yield { type: "request.end", message: message(2) }
      yield { type: "retry", attempt: 1, maxRetries: 1, delayMs: 0, error: { message: "temporary failure" } }
      yield { type: "request.start" }
      yield {
        type: "error",
        error: { message: "aborted", code: "aborted" },
        retryable: false,
        message: { ...message(3), stopReason: "aborted" },
      }
    },
  },
  {
    name: "retains failed request usage when its final error has no usage",
    costs: [2],
    succeeds: false,
    async *stream() {
      const reply = message(2)
      yield { type: "request.start" }
      yield { type: "request.end", message: reply }
      yield {
        type: "error",
        error: { message: "failed" },
        retryable: false,
        message: { ...reply, stopReason: "error", usage: undefined },
      }
    },
  },
]

for (const kind of ["approval", "question"] as const) {
  const consult = (consultant: ParentConsultant, parent: Agent, signal: AbortSignal) =>
    kind === "approval"
      ? consultant.approve(
          parent,
          { sessionId: "child", toolCallId: "read-1", name: "read", args: {}, reason: "approval needed" },
          signal,
        )
      : consultant.ask(
          parent,
          { sessionId: "child", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
          signal,
        )

  test(`${kind} admission captures the usage owner and request model before waiting`, async () => {
    const mock = createMockDialect([{ text: kind === "approval" ? "APPROVE" : "1: Yes", usage: { cost: 3 } }])
    const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const parent = new Agent({ ai, model: ai.model("mock/original"), cwd: process.cwd(), sections: [] })
    const waiting = Promise.withResolvers<void>()
    const permit = Promise.withResolvers<void>()
    const order: string[] = []
    const costs: number[] = []
    const consultant = new ParentConsultant({
      ai,
      callableTools: () => undefined,
      usageRecorder: (owner, requester) => {
        expect(owner).toBe(parent)
        expect(requester).toBe("child")
        expect(owner.model.id).toBe("original")
        order.push("captured")
        return (usage) => {
          costs.push(usage.cost ?? 0)
          order.push("recorded")
        }
      },
      acquire: async (requester) => {
        expect(requester).toBe("child")
        order.push("waiting")
        waiting.resolve()
        await permit.promise
        return () => order.push("released")
      },
    })
    try {
      const result = consult(consultant, parent, new AbortController().signal)
      await waiting.promise
      expect(order).toEqual(["captured", "waiting"])
      expect(mock.requests).toHaveLength(0)
      parent.setModel(ai.model("mock/changed"))
      permit.resolve()
      await result
      expect(mock.requests).toHaveLength(1)
      expect(mock.requests[0]!.model.id).toBe("original")
      expect(costs).toEqual([3])
      expect(order).toEqual(["captured", "waiting", "recorded", "released"])
    } finally {
      permit.resolve()
      await parent.dispose()
    }
  })

  test(`${kind} admission rechecks abort after its permit and releases without a stream`, async () => {
    const mock = createMockDialect()
    const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const parent = new Agent({ ai, model: ai.model("mock/m"), cwd: process.cwd(), sections: [] })
    const controller = new AbortController()
    const released = Promise.withResolvers<void>()
    let recordings = 0
    const consultant = new ParentConsultant({
      ai,
      callableTools: () => undefined,
      usageRecorder: () => () => recordings++,
      acquire: async () => {
        controller.abort()
        return () => released.resolve()
      },
    })
    try {
      await consult(consultant, parent, controller.signal)
      await released.promise
      expect(mock.requests).toHaveLength(0)
      expect(recordings).toBe(0)
    } finally {
      await parent.dispose()
    }
  })

  test(`${kind} admission releases even when final usage recording throws`, async () => {
    const mock = createMockDialect([{ text: kind === "approval" ? "APPROVE" : "1: Yes", usage: { cost: 3 } }])
    const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const parent = new Agent({ ai, model: ai.model("mock/m"), cwd: process.cwd(), sections: [] })
    let releases = 0
    const consultant = new ParentConsultant({
      ai,
      callableTools: () => undefined,
      usageRecorder: () => () => {
        throw new Error("recording failed")
      },
      acquire: async () => () => releases++,
    })
    try {
      await expect(consult(consultant, parent, new AbortController().signal)).rejects.toThrow(
        "recording failed",
      )
      expect(mock.requests).toHaveLength(1)
      expect(releases).toBe(1)
    } finally {
      await parent.dispose()
    }
  })
  test(`${kind} consultation counts an aborted retry without dialect request.start`, async () => {
    const controller = new AbortController()
    const mock = createMockDialect([
      { error: { message: "temporary failure", retryable: true }, usage: { cost: 2 } },
      { text: kind === "approval" ? "APPROVE" : "1: Yes", usage: { cost: 3 } },
    ])
    const ai = createAi({
      dialects: [
        {
          ...mock,
          async *stream(request, context) {
            for await (const event of mock.stream(request, context)) {
              if (event.type === "start" && mock.requests.length === 2) controller.abort()
              yield event
            }
          },
        },
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 1, baseDelayMs: 0 },
    })
    const parent = new Agent({ ai, model: ai.model("mock/m"), cwd: process.cwd(), sections: [] })
    const costs: number[] = []
    const consultant = new ParentConsultant({
      ai,
      callableTools: () => undefined,
      usageRecorder: (chargedParent, requester) => {
        expect(chargedParent).toBe(parent)
        expect(requester).toBe("child")
        return (usage) => costs.push(usage.cost ?? 0)
      },
    })
    try {
      if (kind === "approval") {
        const result = await consultant.approve(
          parent,
          { sessionId: "child", toolCallId: "read-1", name: "read", args: {}, reason: "approval needed" },
          controller.signal,
        )
        expect(result.approved).toBe(false)
      } else {
        const result = await consultant.ask(
          parent,
          { sessionId: "child", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
          controller.signal,
        )
        expect(result).toHaveProperty("unavailable")
      }
      expect(mock.requests).toHaveLength(2)
      expect(costs).toEqual([2, 3])
      expect(costs.reduce((sum, cost) => sum + cost, 0)).toBe(5)
    } finally {
      await parent.dispose()
    }
  })

  for (const scenario of cases) {
    test(`${kind} consultation ${scenario.name}`, async () => {
      const base = createAi({
        dialects: [createMockDialect()],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      })
      const ai: Ai = { ...base, stream: () => scenario.stream(kind === "approval" ? "APPROVE" : "1: Yes") }
      const parent = new Agent({ ai, model: ai.model("mock/m"), cwd: process.cwd(), sections: [] })
      const costs: number[] = []
      const consultant = new ParentConsultant({
        ai,
        callableTools: () => undefined,
        usageRecorder: (chargedParent, requester) => {
          expect(chargedParent).toBe(parent)
          expect(requester).toBe("child")
          return (usage) => costs.push(usage.cost ?? 0)
        },
      })
      const signal = new AbortController().signal
      try {
        if (kind === "approval") {
          const result = await consultant.approve(
            parent,
            { sessionId: "child", toolCallId: "read-1", name: "read", args: {}, reason: "approval needed" },
            signal,
          )
          expect(result.approved).toBe(scenario.succeeds)
        } else {
          const result = await consultant.ask(
            parent,
            { sessionId: "child", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
            signal,
          )
          if (scenario.succeeds)
            expect(result).toEqual({ answers: [{ selected: ["Yes"] }], by: "the commander" })
          else expect(result).toHaveProperty("unavailable")
        }
        expect(costs).toEqual(scenario.costs)
      } finally {
        await parent.dispose()
      }
    })
  }
}
