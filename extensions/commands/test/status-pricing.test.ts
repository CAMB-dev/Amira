import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AssistantMessage, SessionControl, Usage } from "@amira/api"
import { createAi, createMockDialect } from "../../../packages/ai/src/index.ts"
import {
  Agent,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import { statusCommand } from "../src/status-command.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const model = { provider: "mock", model: "m" }
const usage = (cost: number, pricingUnknown = false): Usage => ({
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  cost,
  ...(pricingUnknown ? { pricingUnknown: true } : {}),
})

async function status(
  source: "reply" | "compaction" | "side request" | "subagent",
  estimated: boolean,
  withSubs = true,
) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-status-pricing-"))
  const bus = new EventBus()
  const ext = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await ext.load((api) => {
    api.registerCommand(statusCommand(api))
  }, "test:status")
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: home, bus, systemPrompt: "" })
  cleanups.push(async () => {
    ext.unload("test:status")
    await agent.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const reply: AssistantMessage = {
    role: "assistant",
    content: [],
    model,
    usage: usage(1, source === "reply" && estimated),
  }
  const control: Partial<SessionControl> = {
    info: () => ({ id: "s", cwd: home, model, contextWindow: 128000, busy: false, shell: "auto" }),
    replies: () => [reply],
    providers: () => [],
    compactions: () => [{ model, usage: usage(2, source === "compaction" && estimated) }],
    sideRequests: () => [{ model, usage: usage(4, source === "side request" && estimated) }],
    subagents: () =>
      withSubs
        ? [
            {
              id: "child",
              parentSessionId: "s",
              depth: 1,
              role: "agent",
              title: "work",
              task: "work",
              status: "done",
              usage: usage(8, source === "subagent" && estimated),
            },
          ]
        : [],
  }
  const host = new CommandHost({
    registry: ext.commands,
    skills: ext.skills,
    bus,
    ui: ext.ui,
    control: control as SessionControl,
    agent,
  })
  bus.emit("workspace.changed", { cwd: home }, { sessionId: "s" })
  await bus.flush()
  const result = await host.run("/status", { frontend: "print" })
  return result.output
    .join("\n")
    .split("\n")
    .find((line) => /^Cost\s/.test(line))
}

for (const source of ["reply", "compaction", "side request", "subagent"] as const) {
  test(`/status labels aggregate costs estimated by a ${source} without changing confirmed totals`, async () => {
    const confirmed = await status(source, false)
    expect(confirmed).toMatch(
      /Cost\s+\$15\.00 with sub-agents; this session alone \$7\.00; of which compaction \$2\.00$/,
    )
    const estimated = await status(source, true)
    expect(estimated).toContain("$15.00 (standard-rate estimate) with sub-agents")
    expect(estimated).toContain(
      source === "subagent"
        ? "this session alone $7.00;"
        : "this session alone $7.00 (standard-rate estimate)",
    )
    expect(estimated).toContain(
      source === "compaction" ? "compaction $2.00 (standard-rate estimate)" : "compaction $2.00",
    )
  })
}

test("/status also marks estimated session totals without subagents", async () => {
  expect(await status("reply", false, false)).toMatch(
    /Cost\s+\$7\.00 \(this session; no sub-agents\); of which compaction \$2\.00$/,
  )
  expect(await status("reply", true, false)).toMatch(
    /Cost\s+\$7\.00 \(standard-rate estimate\) \(this session; no sub-agents\); of which compaction \$2\.00$/,
  )
})
