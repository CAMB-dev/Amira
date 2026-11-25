import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { FrontendView } from "@amira/api"
import { Agent, EventBus, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { ExtensionHost } from "../src/extensions.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test("ExtensionAPI.openView delegates to bound frontend opener and closes owned views on unload", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    settings: {},
  })
  const opened: FrontendView[] = []
  const closed: string[] = []

  let openViewFn: ((view: FrontendView) => boolean) | undefined
  let extSignal: AbortSignal | undefined
  let extServiceNames: (() => readonly string[]) | undefined
  await host.load((api) => {
    openViewFn = api.openView
    extSignal = api.signal
    extServiceNames = api.serviceNames
    api.provideService("pair.peers", () => [])
  }, "pair-ext")

  expect(extSignal?.aborted).toBe(false)
  expect(extServiceNames?.()).toEqual(["pair.peers"])

  const sampleView: FrontendView = {
    kind: "pair-dock",
    placement: "dock",
    data: {},
  }

  // Unbound frontend returns false safely.
  expect(openViewFn?.(sampleView)).toBe(false)

  const detach = host.bindOpenView((view) => {
    opened.push(view)
    host.views.watch(view, () => closed.push(view.kind))
    return true
  })
  expect(openViewFn?.(sampleView)).toBe(true)
  expect(opened).toHaveLength(1)
  expect(opened[0]!.kind).toBe("pair-dock")

  // Unloading the extension closes owned views and disables retained openView references.
  await host.unload("pair-ext")
  expect(closed).toEqual(["pair-dock"])
  expect(openViewFn?.(sampleView)).toBe(false)
  expect(extSignal?.aborted).toBe(true)
  expect(extServiceNames?.()).toEqual([])

  detach()
})

test("OwnedConversation with ephemeral: true runs in memory without writing files to disk", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-ephemeral-owned-"))
  const mock = createMockDialect([{ text: "private peer reply" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  cleanups.push(async () => {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  const owner = manager.forOwner("pair-ext")
  const handle = await owner.openOrCreate(
    {
      key: "pair/pm-room-1",
      name: "Pair with PM",
      cwd: home,
      model: "mock/test",
      systemPrompt: "Answer only from shared context.",
      callableTools: [],
      writeRoots: [],
      ephemeral: true,
    },
    { askUser: async () => undefined },
  )

  // Re-opening same key returns the live in-memory handle.
  expect(
    await owner.openOrCreate(
      {
        key: "pair/pm-room-1",
        name: "Pair with PM",
        cwd: home,
        model: "mock/test",
        systemPrompt: "Answer only from shared context.",
        callableTools: [],
        writeRoots: [],
        ephemeral: true,
      },
      { askUser: async () => undefined },
    ),
  ).toBe(handle)

  await handle.send("What is the checkout timeout?")
  expect(handle.history().map((m) => m.role)).toEqual(["user", "assistant"])
  const snap = await owner.read({ key: "pair/pm-room-1" })
  expect(snap?.history.map((m) => m.role)).toEqual(["user", "assistant"])
  expect(existsSync(path.join(home, "owned-conversations"))).toBe(false)

  await handle.release()
  expect(await owner.read({ key: "pair/pm-room-1" })).toBeUndefined()
  expect(existsSync(path.join(home, "owned-conversations"))).toBe(false)
})
