import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { OwnedConversation, SessionControl } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { createLocalAgentPort } from "../src/frontend/local-port.ts"
import { bindLocalConversation } from "../src/frontend/operations.ts"
import type { FrontendOperations } from "../src/frontend/port.ts"
import { registerConversationTurn } from "../src/session-routing.ts"

type OperationCase = {
  [K in keyof FrontendOperations]: readonly [K, FrontendOperations[K]["params"]]
}[keyof FrontendOperations]
const operations = [
  ["state.read", {}],
  ["transcript.read", {}],
  ["turn.prompt", { message: "old", turnId: "old-prompt" }],
  ["turn.steer", { message: "old", expectedTurnId: "old-turn" }],
  ["turn.abort", { turnId: "old-turn" }],
  ["command.run", { line: "/old", invocationId: "command" }],
  ["skill.run", { line: "$old", invocationId: "skill" }],
  ["input.run", { line: "old", invocationId: "input" }],
  ["session.clear", {}],
  ["session.resume", { id: "old-session" }],
  ["session.fork", { index: 0 }],
  ["session.planRewind", { index: 0 }],
  ["session.rewind", { index: 0, restoreFiles: false }],
  [
    "conversation.send",
    { conversationId: "owned", incarnation: "old-handle", message: "old", turnId: "old-owned" },
  ],
  ["conversation.stop", { conversationId: "owned", incarnation: "old-handle", expectedTurnId: "old-owned" }],
] as const satisfies readonly OperationCase[]

function fixture() {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const first = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  const second = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  let switched!: (next: Agent) => void
  const effects: string[] = []
  const command = async () => {
    effects.push("command")
    return { ok: true, output: [] }
  }
  const control = {
    newSession: async () => {
      effects.push("clear")
    },
    resume: async () => {
      effects.push("resume")
    },
    fork: async () => {
      effects.push("fork")
    },
    rewind: async () => {
      effects.push("rewind")
    },
    planRewind: () => {
      effects.push("plan")
      return { owner: "core", enabled: false, restored: 0, removed: 0, conflicts: [], note: "" }
    },
  } as unknown as SessionControl
  const port = createLocalAgentPort({
    agent: first,
    commands: {
      onSwitch: (listener) => {
        switched = listener
        return () => {}
      },
      run: command,
      runSkill: command,
      runInput: command,
      control,
    },
  })
  return {
    first,
    second,
    port,
    effects,
    switchRoot: () => switched(second),
    async close() {
      await port.detach()
      await first.dispose()
      await second.dispose()
    },
  }
}

for (const [operation, params] of operations) {
  for (const fence of ["session", "detach", "cancel"] as const) {
    test(`delayed ${operation} admission is fenced by ${fence}`, async () => {
      const s = fixture()
      const gate = Promise.withResolvers<void>()
      const caller = new AbortController()
      const generation = s.port.identity!.sessionGeneration
      const delayed = gate.promise
        .then(() =>
          s.port.execute(operation, JSON.parse(JSON.stringify(params)), {
            sessionGeneration: generation,
            signal: caller.signal,
          }),
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      try {
        if (fence === "session") s.switchRoot()
        else if (fence === "detach") await s.port.detach()
        else caller.abort()
        gate.resolve()
        expect(await delayed).toMatchObject({
          error: {
            code: fence === "session" ? "stale_session" : fence === "detach" ? "disconnected" : "cancelled",
          },
        })
        expect(s.effects).toEqual([])
        expect(s.second.messages).toEqual([])
        expect(s.first.messages).toEqual([])
      } finally {
        gate.resolve()
        await delayed
        await s.close()
      }
    })
  }
}

for (const operation of ["conversation.send", "conversation.stop"] as const) {
  test(`late ${operation} result retains its admitted generation rather than borrowing the replacement's`, async () => {
    const s = fixture()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const handle = {
      id: "owned",
      send: async () => {
        entered.resolve()
        await gate.promise
      },
      stop: async () => {
        entered.resolve()
        await gate.promise
      },
    } as unknown as OwnedConversation
    registerConversationTurn(handle, () => "owned-turn")
    const unbind = bindLocalConversation(s.port, handle)
    const generation = s.port.identity!.sessionGeneration
    const request =
      operation === "conversation.send"
        ? s.port.execute(
            operation,
            { conversationId: "owned", incarnation: unbind.incarnation, message: "work" },
            { sessionGeneration: generation },
          )
        : s.port.execute(
            operation,
            { conversationId: "owned", incarnation: unbind.incarnation, expectedTurnId: "owned-turn" },
            { sessionGeneration: generation },
          )
    try {
      await entered.promise
      s.switchRoot()
      gate.resolve()
      expect(await request).toEqual({ sessionGeneration: generation })
      expect(s.port.identity!.sessionGeneration).toBe(generation + 1)
    } finally {
      gate.resolve()
      await request
      unbind()
      await s.close()
    }
  })
}

for (const originalKind of ["turn", "hold"] as const) {
  for (const replacementKind of ["turn", "hold"] as const) {
    for (const operation of ["turn.abort", "turn.steer", "turn.prompt"] as const) {
      if (operation === "turn.prompt" && originalKind !== "hold") continue
      test(`${operation} for ${originalKind} cannot affect a replacement ${replacementKind} in the same session`, async () => {
        const first = Promise.withResolvers<void>()
        const second = Promise.withResolvers<void>()
        const ai = createAi({
          dialects: [
            createMockDialect([
              ...(originalKind === "turn"
                ? [{ text: "old", hold: { chunks: 0, until: first.promise } }]
                : []),
              { text: "new", hold: { chunks: 0, until: second.promise } },
            ]),
          ],
          providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
        })
        const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
        const port = createLocalAgentPort({ agent })
        let replacementSignal: AbortSignal | undefined
        const old =
          originalKind === "turn" ? agent.prompt("original") : agent.hold("compaction", () => first.promise)
        const oldId = originalKind === "turn" ? agent.turnId! : agent.holdId!
        let replacement: ReturnType<Agent["prompt"]> | Promise<void> | undefined
        try {
          expect(oldId).toBeDefined()
          first.resolve()
          await old
          replacement =
            replacementKind === "turn"
              ? agent.prompt("replacement")
              : agent.hold("compaction", (signal) => {
                  replacementSignal = signal
                  return second.promise
                })
          const request =
            operation === "turn.abort"
              ? port.execute(operation, originalKind === "turn" ? { turnId: oldId } : { holdId: oldId })
              : operation === "turn.steer"
                ? port.execute(operation, {
                    message: "obsolete steer",
                    ...(originalKind === "turn" ? { expectedTurnId: oldId } : { expectedHoldId: oldId }),
                  })
                : port.execute(operation, { message: "obsolete prompt", expectedHoldId: oldId })
          if (operation === "turn.abort") await request
          else await expect(request).rejects.toMatchObject({ code: "stale_operation" })
          expect(replacementSignal?.aborted ?? false).toBe(false)
          second.resolve()
          const result = await replacement
          if (result) expect(result.reason).toBe("done")
        } finally {
          first.resolve()
          second.resolve()
          await old
          await replacement
          await port.detach()
          await agent.dispose()
        }
      })
    }
  }
}
