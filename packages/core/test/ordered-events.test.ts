import { expect, test } from "bun:test"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("extensions can observe related events in one ordered, owned queue", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  const seen: string[] = []
  await host.load((api) => {
    expect(api.onEvents).toBeDefined()
    api.onEvents?.(["message.start", "message.stream", "message.end"], (e) => {
      seen.push(e.type)
    })
  }, "ordered")
  const model = { provider: "p", model: "m" }
  const meta = { sessionId: "s" }
  bus.emit("message.start", { model }, meta)
  bus.emit("message.stream", { kind: "request" }, meta)
  bus.emit("message.stream", { kind: "contentStart" }, meta)
  bus.emit("message.stream", { kind: "end", outputTokens: 100 }, meta)
  bus.emit("message.end", { message: { role: "assistant", model, content: [] } }, meta)
  bus.emit("events.lost", { dropped: 1 }, meta)
  await bus.flush()
  expect(seen).toEqual([
    "message.start",
    "message.stream",
    "message.stream",
    "message.stream",
    "message.end",
    "events.lost",
  ])
  host.unload("ordered")
  bus.emit("message.start", { model }, meta)
  await bus.flush()
  expect(seen).toHaveLength(6)
})
