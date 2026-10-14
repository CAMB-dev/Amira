import { expect, test } from "bun:test"
import type { AnyEvent, ExtensionAPI } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function setup() {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  return { bus, host }
}

test("lightweight hosts without conversation dependencies do not expose owned conversations", async () => {
  const { host } = setup()
  expect(
    await host.load((api) => {
      expect(api.conversations).toBeUndefined()
    }, "test:lightweight"),
  ).toBe(true)
  host.unloadAll()
  await host.drain()
})

test("unload hooks run once per instance on reload and exit, before registrations disappear", async () => {
  const { bus, host } = setup()
  const calls: string[] = []
  const load = async (instance: number) => {
    await host.load((api) => {
      api.registerView({ kind: "test", title: () => "Test", render: () => [] })
      api.onUnload(() => {
        expect(host.views.get("test")).toBeDefined()
        calls.push(`unload ${instance}`)
        host.unload("test") // Reentrant unload must not run the hooks again.
      })
      api.onUnload(() => void calls.push("removed"))()
      api.onExit(() => void calls.push(`exit ${instance}`))
      api.on("session.end", () => void calls.push(`end ${instance}`))
    }, "test")
  }
  await load(1)
  host.unloadAll()
  expect(calls).toEqual(["unload 1"])
  await load(2)
  bus.emit("session.end", { reason: "exit" }, { sessionId: "s" })
  await host.runExitHandlers()
  expect(calls).toEqual(["unload 1", "end 2", "exit 2", "unload 2"])
  expect(host.loaded).toEqual([])
  await host.runExitHandlers()
  host.unloadAll()
  expect(calls).toEqual(["unload 1", "end 2", "exit 2", "unload 2"])
})

test("exit unloads extensions without exit handlers after delivering session.end", async () => {
  const { bus, host } = setup()
  const calls: string[] = []
  await host.load((api) => {
    api.on("session.end", () => void calls.push("end"))
    api.onUnload(() => void calls.push("unload"))
  }, "test")
  bus.emit("session.end", { reason: "exit" }, { sessionId: "s" })
  await host.runExitHandlers()
  expect(calls).toEqual(["end", "unload"])
})

test("failed loads and throwing unload hooks still clean up once", async () => {
  const { bus, host } = setup()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  let api!: ExtensionAPI
  let cleaned = 0
  expect(
    await host.load((a) => {
      api = a
      a.registerView({ kind: "failed", title: () => "Failed", render: () => [] })
      a.onUnload(() => {
        throw new Error("cleanup failed")
      })
      a.onUnload(() => {
        cleaned++
      })
      throw new Error("load failed")
    }, "test"),
  ).toBe(false)
  expect(cleaned).toBe(1)
  expect(host.views.kinds()).toEqual([])
  api.onUnload(() => {
    cleaned++
  })
  host.unloadAll()
  expect(cleaned).toBe(1)
  await bus.flush()
  expect(events.filter((e) => e.type === "extension.error").map((e) => e.data.error)).toEqual([
    "unload handler failed: cleanup failed",
    "load failed",
  ])
})
