import { expect, test } from "bun:test"
import type { EventMap } from "@amira/api"
import {
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import statusExtension from "../src/index.ts"

async function setup() {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load(statusExtension, "test:status")
  const cost = () => host.status.snapshot().find((item) => item.id === "cost")?.text
  const model = { provider: "mock", model: "m" }
  const meta = { sessionId: "root" }
  const reset = () => bus.emit("session.start", { cwd: "/test", model, reason: "clear" }, meta)
  const reply = (pricingUnknown = false, child = false) => {
    bus.emit(
      "message.end",
      {
        message: {
          role: "assistant",
          content: [],
          model,
          usage: {
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 1,
            ...(pricingUnknown ? { pricingUnknown: true } : {}),
          },
        },
      },
      child ? { sessionId: "child", parentSessionId: "root" } : meta,
    )
  }
  return { bus, host, cost, meta, reset, reply }
}

for (const child of [false, true]) {
  test(`the status marks estimated ${child ? "subagent" : "own"} replies until a new session`, async () => {
    const { bus, host, cost, reset, reply } = await setup()
    try {
      reply()
      await bus.flush()
      expect(cost()).toBe("$1.00")
      reply(true, child)
      reply()
      await bus.flush()
      expect(cost()).toBe("~$3.00")
      reset()
      reply()
      await bus.flush()
      expect(cost()).toBe("$1.00")
    } finally {
      host.unload("test:status")
    }
  })
}

test("budget updates retain the tree's estimate marker including calls outside replies", async () => {
  const { bus, host, cost, meta, reset } = await setup()
  try {
    const update = (data: EventMap["budget.update"]) => bus.emit("budget.update", data, meta)
    update({ tokens: 100, costUsd: 1 })
    await bus.flush()
    expect(cost()).toBe("$1.00")
    update({ tokens: 200, costUsd: 3, pricingUnknown: true })
    await bus.flush()
    expect(cost()).toBe("~$3.00")
    // Another priced reply must not remove the accumulated estimate marker.
    update({ tokens: 300, costUsd: 4, pricingUnknown: true })
    await bus.flush()
    expect(cost()).toBe("~$4.00")
    reset()
    update({ tokens: 100, costUsd: 1 })
    await bus.flush()
    expect(cost()).toBe("$1.00")
  } finally {
    host.unload("test:status")
  }
})
