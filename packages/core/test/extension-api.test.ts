import { expect, test } from "bun:test"
import type { AnyEvent, ExtensionAPI } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { amiraHome } from "../src/home.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("extensions get the cwd, the user directory and a way to report later failures", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd: "/some/project",
  })
  let api: ExtensionAPI | undefined
  await host.load((a) => {
    api = a
  }, "ext:test")
  expect(api!.cwd).toBe("/some/project")
  expect(api!.home).toBe(amiraHome())
  api!.reportError("server x failed")
  await bus.flush()
  expect(events.at(-1)).toMatchObject({
    type: "extension.error",
    data: { source: "ext:test", error: "server x failed" },
  })
})

test("tool renderers: the last one registered for a tool wins, and unloading restores the one before", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  const first = { summary: () => "first" }
  const second = { summary: () => "second" }
  await host.load((api) => void api.registerToolRenderer("read", first), "ext:a")
  expect(host.renderers.get("read")).toBe(first)
  await host.load((api) => void api.registerToolRenderer("read", second), "ext:b")
  expect(host.renderers.get("read")).toBe(second)
  host.unload("ext:b")
  expect(host.renderers.get("read")).toBe(first)
  host.unload("ext:a")
  expect(host.renderers.get("read")).toBeUndefined()
})

test("views: the last one registered for a kind wins, unloading restores the one before, built-in kinds are refused", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  const first = { kind: "workflow", title: () => "first", render: () => [] }
  const second = { kind: "workflow", title: () => "second", render: () => [] }
  await host.load((api) => void api.registerView(first), "ext:a")
  await host.load((api) => {
    api.registerView(second)
    api.registerView({ kind: "subagent", title: () => "", render: () => [] })
  }, "ext:b")
  expect(host.views.get("workflow")).toBe(second)
  expect(host.views.get("subagent")).toBeUndefined()
  expect(host.loaded).toContain("ext:b")
  await bus.flush()
  expect(events.find((e) => e.type === "extension.error")?.data).toEqual({
    source: "ext:b",
    error: 'the view kind "subagent" is built in',
  })
  host.unload("ext:b")
  expect(host.views.get("workflow")).toBe(first)
  host.unload("ext:a")
  expect(host.views.kinds()).toEqual([])
})
