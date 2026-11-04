import { expect, test } from "bun:test"
import type { ExtensionFrontend } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

async function frontendSeen(frontend?: ExtensionFrontend): Promise<ExtensionFrontend | undefined> {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    ...(frontend ? { frontend } : {}),
  })
  let seen: ExtensionFrontend | undefined
  const ok = await host.load((api) => {
    seen = api.frontend
  }, "frontend-test")
  expect(ok).toBe(true)
  return seen
}

test("extensions see how the process runs Amira; another host is embedded", async () => {
  expect(await frontendSeen()).toBe("embedded")
  expect(await frontendSeen("print")).toBe("print")
  expect(await frontendSeen("tui")).toBe("tui")
})
