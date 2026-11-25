import { expect, test } from "bun:test"
import type { ExtensionAPI } from "@amira/api"
import { EventBus, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { ExtensionHost } from "../src/extensions.ts"

test("onServiceChange notifies on provide, dispose, provider unload, and cleans up on subscriber unload", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  const errors: string[] = []
  bus.subscribe(
    (e) => {
      if (e.type === "extension.error") errors.push(e.data.error)
    },
    { types: ["extension.error"] },
  )

  const seen: unknown[] = []
  let subApi!: ExtensionAPI
  await host.load((api) => {
    subApi = api
    api.onServiceChange("demo.runner" as never, (svc) => {
      seen.push(svc)
    })
  }, "ext:subscriber")

  let offService!: () => void
  const svc1 = { version: 1 }
  await host.load((api) => {
    offService = api.provideService("demo.runner" as never, svc1 as never)
  }, "ext:provider")
  expect(seen).toEqual([svc1])
  expect(subApi.useService("demo.runner" as never) as unknown).toBe(svc1)

  // Manual disposal notifies with undefined.
  offService()
  expect(seen).toEqual([svc1, undefined])

  // Re-registering and unloading the provider notifies both transitions.
  const svc2 = { version: 2 }
  await host.load((api) => {
    api.provideService("demo.runner" as never, svc2 as never)
  }, "ext:provider2")
  expect(seen).toEqual([svc1, undefined, svc2])
  await host.unload("ext:provider2")
  expect(seen).toEqual([svc1, undefined, svc2, undefined])

  // Unloading the subscriber removes its listener automatically.
  await host.unload("ext:subscriber")
  await host.load((api) => {
    api.provideService("demo.runner" as never, { version: 3 } as never)
  }, "ext:provider3")
  expect(seen).toEqual([svc1, undefined, svc2, undefined])
  expect(errors).toEqual([])
})

test("onServiceChange isolates listener errors without breaking other listeners", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  const errors: string[] = []
  bus.subscribe(
    (e) => {
      if (e.type === "extension.error") errors.push(e.data.error)
    },
    { types: ["extension.error"] },
  )
  const received: unknown[] = []
  await host.load((api) => {
    api.onServiceChange("bad.svc" as never, () => {
      throw new Error("boom")
    })
  }, "ext:bad")
  await host.load((api) => {
    api.onServiceChange("bad.svc" as never, (svc) => {
      received.push(svc)
    })
  }, "ext:good")

  const value = { ok: true }
  await host.load((api) => {
    api.provideService("bad.svc" as never, value as never)
  }, "ext:owner")

  expect(received).toEqual([value])
  expect(errors).toContain("boom")
})
