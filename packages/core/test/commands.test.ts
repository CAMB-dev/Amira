import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, CommandDefinition, SessionControl } from "@amira/api"
import { Agent } from "../src/agent.ts"
import {
  CommandConflictError,
  CommandHost,
  CommandRegistry,
  fuzzyScore,
  parseCommandLine,
  rankMatches,
} from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

const cmd = (name: string, extra: Partial<CommandDefinition> = {}): CommandDefinition => ({
  name,
  description: `the ${name} command`,
  run: () => {},
  ...extra,
})

test("the registry refuses a taken name without override and restores the one below on removal", () => {
  const r = new CommandRegistry()
  r.register(cmd("help"), "builtin")
  expect(() => r.register(cmd("help"), "ext")).toThrow(CommandConflictError)
  const off = r.register(cmd("help", { description: "better help", override: true }), "ext")
  expect(r.get("help")).toMatchObject({ source: "ext", def: { description: "better help" } })
  off()
  expect(r.get("help")?.source).toBe("builtin")
  expect(() => r.register(cmd("has space"), "x")).toThrow(/invalid command name/)
  expect(() => r.register(cmd("-dash"), "x")).toThrow(/invalid command name/)
})

test("the registry lists commands by name with their argument hint", () => {
  const r = new CommandRegistry()
  r.register(cmd("model", { args: { hint: "[provider/model]" } }), "builtin")
  r.register(cmd("clear"), "builtin")
  expect(r.list()).toEqual([
    { name: "clear", description: "the clear command", source: "builtin" },
    { name: "model", description: "the model command", hint: "[provider/model]", source: "builtin" },
  ])
})

test("parses command lines but leaves paths and plain text alone", () => {
  expect(parseCommandLine("/help")).toEqual({ name: "help", args: "" })
  expect(parseCommandLine("  /model  deepseek/deepseek-flash ")).toEqual({
    name: "model",
    args: "deepseek/deepseek-flash",
  })
  expect(parseCommandLine("/compact keep\nthe API notes")).toEqual({
    name: "compact",
    args: "keep\nthe API notes",
  })
  expect(parseCommandLine("/usr/bin is empty")).toBeUndefined()
  expect(parseCommandLine("hello /help")).toBeUndefined()
  expect(parseCommandLine("/")).toBeUndefined()
})

test("ranking puts prefix matches first, exact on top, then fuzzy matches best first", () => {
  const names = ["compact", "context", "cost", "clear", "model", "resume", "status", "tools"]
  expect(rankMatches("co", names, (n) => n)).toEqual(["compact", "context", "cost"])
  expect(rankMatches("cost", [...names, "costs"], (n) => n)).toEqual(["cost", "costs"])
  // Not a prefix of anything: subsequence matches, contiguous ones ahead of scattered ones.
  expect(rankMatches("st", names, (n) => n)).toEqual(["status", "cost"])
  expect(rankMatches("ot", names, (n) => n)).toEqual(["context", "cost", "compact"])
  expect(rankMatches("zz", names, (n) => n)).toEqual([])
  expect(rankMatches("", names, (n) => n)).toEqual(names)
  expect(rankMatches("DEEP", ["deepseek/deepseek-flash"], (n) => n)).toEqual(["deepseek/deepseek-flash"])
})

test("fuzzy scores prefer contiguous runs and word starts", () => {
  expect(fuzzyScore("fl", "deepseek/deepseek-flash")).toBeLessThan(
    fuzzyScore("fh", "deepseek/deepseek-flash")!,
  )
  expect(fuzzyScore("ds", "deepseek-flash")).toBeDefined()
  expect(fuzzyScore("x", "abc")).toBeUndefined()
})

function hostSetup(control: Partial<SessionControl> = {}) {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
  const registry = new CommandRegistry()
  const host = new CommandHost({
    registry,
    bus,
    ui: new UiRequests(bus),
    control: control as SessionControl,
    agent,
  })
  const outputs = async () => {
    await bus.flush()
    return events.flatMap((e) => (e.type === "command.output" ? [e.data] : []))
  }
  return { bus, agent, ai, registry, host, outputs }
}

test("a frontend with full-screen views hands openView to commands; others leave it unset", async () => {
  const { registry, host } = hostSetup()
  const seen: (boolean | string)[] = []
  registry.register(
    cmd("look", {
      run: (_args, ctx) => {
        seen.push(ctx.openView !== undefined)
        ctx.openView?.({ kind: "subagent", sessionId: "s_child" })
      },
    }),
    "test",
  )
  await host.run("/look", { frontend: "rpc" })
  await host.run("/look", { frontend: "tui", openView: (v) => void seen.push(v.sessionId) })
  expect(seen).toEqual([false, true, "s_child"])
})

test("running a command hands it the arguments and a context, and reports what it prints", async () => {
  const { registry, host, outputs } = hostSetup()
  let seen: { args: string; frontend: string; cwd: string; names: string[] } | undefined
  let quit = false
  registry.register(
    cmd("echo", {
      run: (args, ctx) => {
        seen = { args, frontend: ctx.frontend, cwd: ctx.cwd, names: ctx.commands().map((c) => c.name) }
        ctx.print(`echo ${args}`)
        ctx.print("careful", "warning")
        ctx.quit()
      },
    }),
    "test",
  )
  const r = await host.run("/echo  hi there ", { frontend: "rpc", quit: () => (quit = true) })
  expect(r).toEqual({ ok: true, command: "echo", output: ["echo hi there", "careful"] })
  expect(seen).toEqual({ args: "hi there", frontend: "rpc", cwd: "/work", names: ["echo"] })
  expect(quit).toBe(true)
  expect(await outputs()).toEqual([
    { command: "echo", text: "echo hi there", level: "info" },
    { command: "echo", text: "careful", level: "warning" },
  ])
})

test("unknown commands and failing commands are reported, never thrown", async () => {
  const { registry, host, outputs } = hostSetup()
  registry.register(
    cmd("boom", {
      run: () => {
        throw new Error("it broke")
      },
    }),
    "test",
  )
  expect(await host.run("/nope", { frontend: "tui" })).toMatchObject({ ok: false, command: "nope" })
  expect(await host.run("/boom", { frontend: "tui" })).toMatchObject({ ok: false, error: "it broke" })
  const levels = (await outputs()).map((o) => [o.command, o.level, o.text])
  expect(levels[0]).toEqual(["nope", "error", "Unknown command /nope. Type /help to list the commands."])
  expect(levels[1]).toEqual(["boom", "error", "it broke"])
})

test("completion ranks command names, then the command's own argument candidates", async () => {
  const { registry, host } = hostSetup({ models: () => ["mock/a", "deepseek/deepseek-flash"] })
  registry.register(
    cmd("model", {
      args: {
        complete: (_prefix, ctx) => ctx.session.models().map((value) => ({ value })),
      },
    }),
    "test",
  )
  registry.register(cmd("mode"), "test")
  registry.register(
    cmd("broken", {
      args: {
        complete: () => {
          throw new Error("no")
        },
      },
    }),
    "test",
  )
  expect((await host.complete("/mo")).candidates.map((c) => c.value)).toEqual(["mode", "model"])
  expect(await host.complete("/model flash")).toEqual({
    command: "model",
    candidates: [{ value: "deepseek/deepseek-flash" }],
  })
  expect((await host.complete("/model ")).candidates.length).toBe(2)
  expect(await host.complete("/mode x")).toEqual({ command: "mode", candidates: [] })
  expect(await host.complete("/broken x")).toEqual({ command: "broken", candidates: [] })
  expect(await host.complete("/unknown x")).toEqual({ candidates: [] })
})

test("switching the active agent tells listeners", () => {
  const { host, ai, bus } = hostSetup()
  const next = new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
  const seen: string[] = []
  const off = host.onSwitch((a) => seen.push(a.sessionId))
  host.switchTo(next)
  off()
  host.switchTo(next)
  expect(seen).toEqual([next.sessionId])
  expect(host.agent).toBe(next)
})

test("extensions register commands; a taken name is reported and skipped, and unload removes them", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load((api) => {
    api.registerCommand(cmd("help"))
  }, "builtin:commands")
  const loaded = await host.load((api) => {
    api.registerCommand(cmd("help"))
    api.registerCommand(cmd("mine"))
  }, "skills")
  await bus.flush()
  expect(loaded).toBe(true)
  expect(host.commands.list().map((c) => [c.name, c.source])).toEqual([
    ["help", "builtin:commands"],
    ["mine", "skills"],
  ])
  expect(events.find((e) => e.type === "extension.error")?.data).toMatchObject({
    source: "skills",
    error: expect.stringContaining("command /help from skills conflicts"),
  })
  host.unloadAll()
  expect(host.commands.list()).toEqual([])
})
