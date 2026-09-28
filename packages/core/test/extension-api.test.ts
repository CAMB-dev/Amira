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
