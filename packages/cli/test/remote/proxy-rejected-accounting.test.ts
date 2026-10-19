import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type AssistantMessage, type CompactResult, emptyUsage, type Usage } from "@amira/ai"
import { encodeUsageReceipt, hasUnpricedUsage } from "@amira/ai/accounting"
import { REMOTE_LIMITS } from "../../src/remote/protocol.ts"
import { collectEvents, proxyFixture, secret } from "./model-proxy-fixture.ts"

const usage = { ...emptyUsage(), input: 17, output: 3, cost: 0.25 }
const message = (): AssistantMessage => ({
  role: "assistant",
  model: { provider: "p", model: "m" },
  content: [],
  usage: { ...usage },
  stopReason: "end",
})

function expectUnknown(value: Usage | undefined) {
  expect(value).toMatchObject({ pricingUnknown: true, outputReported: false })
  expect(hasUnpricedUsage(value!)).toBe(true)
  expect(encodeUsageReceipt(value!)).toMatchObject({
    unknownContributions: 1,
    unreportedContributions: 1,
  })
}

test("transport-generated terminals do not fabricate complete zero accounting", async () => {
  const fixture = proxyFixture(async function* () {}, 10)
  try {
    const stream = await collectEvents(fixture.proxy.stream(fixture.request))
    const terminal = stream.at(-1)
    expect(terminal?.type).toBe("error")
    if (terminal?.type === "error") expectUnknown(terminal.message.usage)
    const compact = await fixture.proxy.compact(fixture.request)
    expect(compact).toMatchObject({ ok: false, usageIncomplete: true })
    expectUnknown(compact.usage)
  } finally {
    fixture.close()
  }
})

function deepArgs(): Record<string, unknown> {
  let args: Record<string, unknown> = { leaf: "unrepresentable tool arguments" }
  for (let index = 0; index <= REMOTE_LIMITS.depth; index++) args = { nested: args }
  return args
}

const invalidTerminals = [
  {
    name: "non-finite usage",
    create: () => ({ ...message(), usage: { ...usage, input: Number.POSITIVE_INFINITY } }),
  },
  {
    name: "valid nonzero usage with over-depth tool JSON",
    create: () => ({
      ...message(),
      content: [{ type: "toolCall" as const, id: "t1", name: "write", args: deepArgs() }],
    }),
  },
  {
    name: "tool JSON serialization hooks",
    create: () => ({
      ...message(),
      content: [
        {
          type: "toolCall" as const,
          id: "t1",
          name: "write",
          args: {
            toJSON() {
              throw new Error(secret)
            },
          },
        },
      ],
    }),
  },
]

for (const { name, create } of invalidTerminals) {
  test(`rejected ${name} has incomplete accounting through the actual proxy`, async () => {
    let calls = 0
    const fixture = proxyFixture(async function* () {
      calls++
      yield { type: "text.delta", text: "safe partial answer" }
      yield { type: "toolCall.delta", index: 0, id: "unfinished", name: "write", argsDelta: "{" }
      yield { type: "done", message: create() }
    })
    try {
      await fixture.connect()
      const events = await collectEvents(fixture.proxy.stream(fixture.request))
      const terminal = events.at(-1)
      expect(terminal).toMatchObject({
        type: "error",
        retryable: false,
        error: { code: "proxy_broker_lost", kind: "network" },
      })
      if (terminal?.type !== "error") throw new Error("Expected a rejected terminal")
      expectUnknown(terminal.message.usage)
      expect(terminal.message.content).toEqual([{ type: "text", text: "safe partial answer" }])
      expect(calls).toBe(1)
      for (const frame of fixture.observed) expect(frame).not.toContain(secret)
    } finally {
      fixture.close()
    }
  })
}

for (const failure of [
  "provider invocation",
  "iterator acquisition",
  "iterator next",
  "terminal accessor",
] as const) {
  test(`broker ${failure} failure never fabricates complete zero accounting`, async () => {
    const fixture = proxyFixture(async function* () {})
    // Inject at the host Ai seam so its own retry/error normalization cannot hide a broker exception.
    fixture.ai.stream = () => {
      if (failure === "provider invocation") throw new Error(secret)
      return {
        [Symbol.asyncIterator]() {
          if (failure === "iterator acquisition") throw new Error(secret)
          return (async function* () {
            yield { type: "text.delta" as const, text: "safe partial answer" }
            yield {
              type: "toolCall.delta" as const,
              index: 0,
              id: "unfinished",
              name: "write",
              argsDelta: "{",
            }
            if (failure === "iterator next") throw new Error(secret)
            const terminal = message()
            Object.defineProperty(terminal, "usage", {
              enumerable: true,
              get() {
                throw new Error(secret)
              },
            })
            yield { type: "done" as const, message: terminal }
          })()
        },
      }
    }
    try {
      await fixture.connect()
      const events = await collectEvents(fixture.proxy.stream(fixture.request))
      const terminal = events.at(-1)
      expect(terminal).toMatchObject({ type: "error", retryable: false })
      if (terminal?.type !== "error") throw new Error("Expected a failed terminal")
      expectUnknown(terminal.message.usage)
      expect(terminal.message.content.some((block) => block.type === "toolCall")).toBe(false)
      for (const frame of fixture.observed) expect(frame).not.toContain(secret)
    } finally {
      fixture.close()
    }
  })
}

for (const failure of ["provider rejection", "result accessor", "result serialization"] as const) {
  test(`discarded compact accounting from ${failure} remains incomplete through the proxy`, async () => {
    const fixture = proxyFixture(async function* () {})
    fixture.ai.compact = async () => {
      if (failure === "provider rejection") throw new Error(secret)
      const result: CompactResult = {
        ok: true,
        checkpoint: { dialect: "fixture", provider: "p", kind: "checkpoint", value: "checkpoint" },
        usage: { ...usage },
        method: "native",
        tried: [],
      }
      if (failure === "result accessor")
        Object.defineProperty(result, "usage", {
          enumerable: true,
          get() {
            throw new Error(secret)
          },
        })
      else
        Object.defineProperty(result.checkpoint, "toJSON", {
          enumerable: true,
          value() {
            throw new Error(secret)
          },
        })
      return result
    }
    try {
      await fixture.connect()
      const result = await fixture.proxy.compact(fixture.request)
      expect(result).toMatchObject({ ok: false, usageIncomplete: true })
      expectUnknown(result.usage)
      for (const frame of fixture.observed) expect(frame).not.toContain(secret)
    } finally {
      fixture.close()
    }
  })
}
