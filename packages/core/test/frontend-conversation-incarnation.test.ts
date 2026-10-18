import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { createLocalAgentPort } from "../src/frontend/local-port.ts"
import { bindLocalConversation } from "../src/frontend/operations.ts"
import { registerConversationTurn, releaseConversationIncarnation } from "../src/session-routing.ts"

function fixture() {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
  const port = createLocalAgentPort({ agent })
  const effects: string[] = []
  const handle = (name: string) => {
    const value = {
      id: "durable",
      send: async () => {
        effects.push(`${name}:send`)
      },
      stop: async () => {
        effects.push(`${name}:stop`)
      },
    } as unknown as OwnedConversation
    registerConversationTurn(value, () => "reused-turn-id")
    return value
  }
  return {
    agent,
    port,
    effects,
    handle,
    async close() {
      await port.detach()
      await agent.dispose()
    },
  }
}

for (const operation of ["conversation.send", "conversation.stop"] as const) {
  for (const lifecycle of ["rebind", "release", "reopen"] as const) {
    test(`${operation} cannot borrow a ${lifecycle} incarnation with the same durable and turn IDs`, async () => {
      const s = fixture()
      const old = s.handle("old")
      const oldBinding = bindLocalConversation(s.port, old)
      const gate = Promise.withResolvers<void>()
      const params =
        operation === "conversation.send"
          ? { conversationId: old.id, incarnation: oldBinding.incarnation, message: "old input" }
          : { conversationId: old.id, incarnation: oldBinding.incarnation, expectedTurnId: "reused-turn-id" }
      const delayed = gate.promise
        .then(() => s.port.execute(operation, JSON.parse(JSON.stringify(params))))
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      let replacement: ReturnType<typeof s.handle> | undefined
      let binding: ReturnType<typeof bindLocalConversation> | undefined
      try {
        if (lifecycle !== "rebind") releaseConversationIncarnation(old)
        if (lifecycle !== "release") {
          replacement = s.handle("replacement")
          binding = bindLocalConversation(s.port, replacement)
          expect(binding.incarnation).not.toBe(oldBinding.incarnation)
        }
        oldBinding() // Late old cleanup must not unbind the replacement.
        gate.resolve()
        expect(await delayed).toMatchObject({ error: { code: "stale_operation" } })
        expect(s.effects).toEqual([])
        if (binding) {
          await s.port.execute(operation, { ...params, incarnation: binding.incarnation })
          expect(s.effects).toEqual([`replacement:${operation === "conversation.send" ? "send" : "stop"}`])
        }
      } finally {
        gate.resolve()
        await delayed
        binding?.()
        oldBinding()
        await s.close()
      }
    })
  }
}

test("releasing an old handle revokes its still-bound incarnation before any replacement is opened", async () => {
  const s = fixture()
  const old = s.handle("old")
  const binding = bindLocalConversation(s.port, old)
  try {
    releaseConversationIncarnation(old)
    await expect(
      s.port.execute("conversation.send", {
        conversationId: old.id,
        incarnation: binding.incarnation,
        message: "old",
      }),
    ).rejects.toMatchObject({ code: "stale_operation" })
    await expect(
      s.port.execute("conversation.stop", { conversationId: old.id, incarnation: binding.incarnation }),
    ).rejects.toMatchObject({ code: "stale_operation" })
    expect(s.effects).toEqual([])
  } finally {
    binding()
    await s.close()
  }
})

test("frontend unbind/detach does not rotate another binding of the same live host handle", async () => {
  const s = fixture()
  const other = createLocalAgentPort({ agent: s.agent })
  const handle = s.handle("live")
  const first = bindLocalConversation(s.port, handle)
  const second = bindLocalConversation(other, handle)
  try {
    expect(first.incarnation).toBe(second.incarnation)
    first()
    await s.port.detach()
    await other.execute("conversation.send", {
      conversationId: handle.id,
      incarnation: second.incarnation,
      message: "still live",
    })
    expect(s.effects).toEqual(["live:send"])
  } finally {
    first()
    second()
    await other.detach()
    await s.close()
  }
})

test("cleanup from an earlier binding cannot remove a newer binding of the same live handle", async () => {
  const s = fixture()
  const handle = s.handle("live")
  const first = bindLocalConversation(s.port, handle)
  const second = bindLocalConversation(s.port, handle)
  try {
    first()
    await s.port.execute("conversation.send", {
      conversationId: handle.id,
      incarnation: second.incarnation,
      message: "current binding",
    })
    expect(s.effects).toEqual(["live:send"])
  } finally {
    first()
    second()
    await s.close()
  }
})
