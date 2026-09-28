import { expect, test } from "bun:test"
import type { AnyEvent, EventEnvelope } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

function setup() {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const ui = new UiRequests(bus)
  const next = async () => {
    await bus.flush()
    return events.filter((e) => e.type === "ui.request").at(-1) as EventEnvelope<"ui.request">
  }
  return { bus, events, ui, next }
}

test("select, confirm and input round trip through events and respond()", async () => {
  const { ui, next, events, bus } = setup()
  const api = ui.api("ext")

  const choice = api.select("Pick", ["a", "b"])
  const req = await next()
  expect(req.data).toMatchObject({ kind: "select", title: "Pick", options: ["a", "b"], source: "ext" })
  expect(ui.respond(req.data.requestId, "c")).toContain("one of the options")
  expect(ui.pending.length).toBe(1)
  expect(ui.respond(req.data.requestId, "b")).toBeUndefined()
  expect(await choice).toBe("b")

  const ok = api.confirm("Sure?", "really")
  expect(ui.respond((await next()).data.requestId, "yes")).toContain("true or false")
  ui.respond((await next()).data.requestId, true)
  expect(await ok).toBe(true)

  const text = api.input("Name", { initial: "x" })
  ui.respond((await next()).data.requestId, "Ada")
  expect(await text).toBe("Ada")

  await bus.flush()
  const resolved = events.flatMap((e) => (e.type === "ui.resolved" ? [e.data] : []))
  expect(resolved.map((r) => r.value)).toEqual(["b", true, "Ada"])
  expect(ui.respond("nope", 1)).toContain("no pending")
})

test("null cancels; timeouts and abort signals cancel too", async () => {
  const { ui, next, events, bus } = setup()
  const api = ui.api()
  const a = api.confirm("Sure?")
  ui.respond((await next()).data.requestId, null)
  expect(await a).toBe(false)

  expect(await api.input("slow", { timeoutMs: 10 })).toBeUndefined()

  const ac = new AbortController()
  const c = api.select("x", ["1"], { signal: ac.signal })
  ac.abort()
  expect(await c).toBeUndefined()
  expect(await api.select("x", ["1"], { signal: ac.signal })).toBeUndefined()

  await bus.flush()
  const resolved = events.flatMap((e) => (e.type === "ui.resolved" ? [e.data.cancelled] : []))
  expect(resolved).toEqual([true, true, true])
  expect(ui.pending).toEqual([])
})

test("extensions get api.ui; unloading one cancels its open dialogs", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  let answer: Promise<string | undefined> | undefined
  await host.load((api) => {
    answer = api.ui.input("Name")
  }, "ext")
  expect(host.ui.pending.map((p) => p.source)).toEqual(["ext"])
  host.unload("ext")
  expect(await answer).toBeUndefined()
})
