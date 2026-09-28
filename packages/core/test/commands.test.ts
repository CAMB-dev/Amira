import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, CommandDefinition, SessionControl } from "@amira/api"
import { Agent } from "../src/agent.ts"
import {
  CommandConflictError,
  CommandHost,
  CommandRegistry,
  commandAliasWarnings,
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
    { name: "clear", aliases: [], description: "the clear command", source: "builtin" },
    {
      name: "model",
      aliases: [],
      description: "the model command",
      hint: "[provider/model]",
      source: "builtin",
    },
  ])
})

test("aliases resolve to their command and are listed with it", () => {
  const r = new CommandRegistry()
  r.register(cmd("quit", { aliases: ["exit", "q"] }), "builtin")
  r.register(cmd("help", { aliases: ["?", "h"] }), "builtin")
  expect(r.get("q")?.def.name).toBe("quit")
  expect(r.get("exit")?.def.name).toBe("quit")
  expect(r.get("?")?.def.name).toBe("help")
  expect(r.has("q")).toBe(false)
  expect(r.has("quit")).toBe(true)
  expect(r.list().map((c) => [c.name, c.aliases])).toEqual([
    ["help", ["?", "h"]],
    ["quit", ["exit", "q"]],
  ])
  expect(() => r.register(cmd("x", { aliases: ["bad alias"] }), "ext")).toThrow(/invalid alias "bad alias"/)
  expect(() => r.register(cmd("x", { aliases: ["x"] }), "ext")).toThrow(/invalid alias/)
  expect(() => r.register(cmd("x", { aliases: ["??"] }), "ext")).toThrow(/invalid alias/)
  expect(r.get("x")).toBeUndefined()
})

test("a command name wins over an alias, and the last claim on an alias wins; both warn", () => {
  const r = new CommandRegistry()
  const warnings: string[] = []
  const warn = (w: string) => void warnings.push(w)
  r.register(cmd("quit", { aliases: ["exit", "q"] }), "builtin", warn)
  // A later command named like an alias takes the name.
  const offQ = r.register(cmd("q"), "ext", warn)
  expect(r.get("q")?.def.name).toBe("q")
  expect(r.list().find((c) => c.name === "quit")?.aliases).toEqual(["exit"])
  // An alias naming an existing command stays shadowed.
  r.register(cmd("leave", { aliases: ["quit"] }), "ext", warn)
  expect(r.get("quit")?.def.name).toBe("quit")
  // Two commands claiming one alias: the later has it until it is removed.
  const offBye = r.register(cmd("bye", { aliases: ["exit"] }), "other", warn)
  expect(r.get("exit")?.def.name).toBe("bye")
  expect(warnings).toEqual([
    "command /q from ext shadows the alias /q of /quit from builtin",
    "alias /quit of /leave is shadowed by the command /quit from builtin",
    "alias /exit now runs /bye from other instead of /quit from builtin",
  ])
  offBye()
  offQ()
  expect(r.get("exit")?.def.name).toBe("quit")
  expect(r.get("q")?.def.name).toBe("quit")
})

test("aliases follow an override of their command's name", () => {
  const r = new CommandRegistry()
  const warnings: string[] = []
  r.register(cmd("quit", { aliases: ["q"] }), "builtin")
  r.register(cmd("quit", { description: "custom quit", override: true, aliases: ["bye"] }), "ext", (w) =>
    warnings.push(w),
  )
  expect(r.get("q")?.def.description).toBe("custom quit")
  expect(r.list()[0]!.aliases).toEqual(["q", "bye"])
  expect(warnings).toEqual([])
})

test("settings aliases that are taken by commands or their aliases are reported", () => {
  const r = new CommandRegistry()
  r.register(cmd("quit", { aliases: ["q"] }), "builtin")
  expect(commandAliasWarnings({ q: "model", quit: "status", m: "model" }, r)).toEqual([
    "commandAliases: /q is already an alias of /quit (from builtin); the setting is ignored",
    "commandAliases: /quit is already a command (from builtin); the setting is ignored",
  ])
  expect(commandAliasWarnings(undefined, r)).toEqual([])
})

test("parses command lines but leaves paths and plain text alone", () => {
  expect(parseCommandLine("/?")).toEqual({ name: "?", args: "" })
  expect(parseCommandLine("/? model")).toEqual({ name: "?", args: "model" })
  expect(parseCommandLine("/?x")).toBeUndefined()
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
  // Several keys per item rank by the best one.
  const cmds = [
    { name: "clear", keys: ["clear", "new", "reset"] },
    { name: "quit", keys: ["quit", "exit", "q"] },
  ]
  expect(rankMatches("ex", cmds, (c) => c.keys).map((c) => c.name)).toEqual(["quit"])
  expect(rankMatches("q", cmds, (c) => c.keys).map((c) => c.name)).toEqual(["quit"])
  expect(rankMatches("rst", cmds, (c) => c.keys).map((c) => c.name)).toEqual(["clear"])
})

test("fuzzy scores prefer contiguous runs and word starts", () => {
  expect(fuzzyScore("fl", "deepseek/deepseek-flash")).toBeLessThan(
    fuzzyScore("fh", "deepseek/deepseek-flash")!,
  )
  expect(fuzzyScore("ds", "deepseek-flash")).toBeDefined()
  expect(fuzzyScore("x", "abc")).toBeUndefined()
})

function hostSetup(control: Partial<SessionControl> = {}, aliases?: Record<string, string>) {
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
    ...(aliases ? { aliases } : {}),
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
  // Names and sync completers answer at once, so the popup draws them with the key.
  expect(host.complete("/mo")).not.toBeInstanceOf(Promise)
  expect(host.complete("/model flash")).not.toBeInstanceOf(Promise)
  registry.register(cmd("later", { args: { complete: async () => [{ value: "x" }] } }), "test")
  const later = host.complete("/later ")
  expect(later).toBeInstanceOf(Promise)
  expect(await later).toEqual({ command: "later", candidates: [{ value: "x" }] })
  expect(await host.complete("/model flash")).toEqual({
    command: "model",
    candidates: [{ value: "deepseek/deepseek-flash" }],
  })
  expect((await host.complete("/model ")).candidates.length).toBe(2)
  expect(await host.complete("/mode x")).toEqual({ command: "mode", candidates: [] })
  expect(await host.complete("/broken x")).toEqual({ command: "broken", candidates: [] })
  expect(await host.complete("/unknown x")).toEqual({ candidates: [] })
})

test("a command's alias runs the command, which the outcome and output name", async () => {
  const { registry, host, outputs } = hostSetup()
  const seen: string[] = []
  registry.register(
    cmd("quit", {
      aliases: ["exit", "q"],
      run: (args, ctx) => {
        seen.push(args)
        ctx.print("bye")
      },
    }),
    "test",
  )
  expect(await host.run("/exit now please", { frontend: "print" })).toEqual({
    ok: true,
    command: "quit",
    output: ["bye"],
  })
  expect(seen).toEqual(["now please"])
  expect((await outputs())[0]).toMatchObject({ command: "quit", text: "bye" })
})

test("settings aliases expand one level, appending what was typed after them", async () => {
  const { registry, host } = hostSetup(
    {},
    {
      m: "model",
      ds: "model deepseek/deepseek-flash",
      q: "status",
      typo: "modle x",
      twice: "ds",
      viaq: "q",
    },
  )
  const seen: string[] = []
  registry.register(cmd("model", { run: (args) => void seen.push(args) }), "test")
  registry.register(cmd("quit", { aliases: ["q"], run: () => void seen.push("quit") }), "test")
  expect(await host.run("/ds", { frontend: "rpc" })).toMatchObject({ ok: true, command: "model" })
  expect(await host.run("/m flash", { frontend: "rpc" })).toMatchObject({ ok: true, command: "model" })
  expect(await host.run("/ds  --fast", { frontend: "rpc" })).toMatchObject({ ok: true })
  // The command's own alias wins over the settings one.
  expect(await host.run("/q", { frontend: "rpc" })).toMatchObject({ ok: true, command: "quit" })
  expect(seen).toEqual(["deepseek/deepseek-flash", "flash", "deepseek/deepseek-flash --fast", "quit"])

  const typo = await host.run("/typo", { frontend: "rpc" })
  expect(typo).toMatchObject({ ok: false, command: "typo" })
  expect(typo.error).toBe(
    'The alias /typo runs /modle, which is not a command; fix "commandAliases" in settings.json or type /help to list the commands.',
  )
  expect((await host.run("/twice", { frontend: "rpc" })).error).toContain(
    "runs /ds, which is an alias itself; aliases resolve one level only, so point it at a command",
  )
  expect((await host.run("/viaq", { frontend: "rpc" })).error).toContain("so point it at /quit")
  expect(host.aliases()).toEqual([
    { name: "ds", expansion: "model deepseek/deepseek-flash" },
    { name: "m", expansion: "model" },
    { name: "twice", expansion: "ds" },
    { name: "typo", expansion: "modle x" },
    { name: "viaq", expansion: "q" },
  ])
})

test("completion matches aliases and offers settings aliases with what they run", async () => {
  const { registry, host } = hostSetup(
    { models: () => ["deepseek/deepseek-flash", "mock/a"] },
    { ds: "model deepseek/deepseek-flash", m: "model", zz: "nothing" },
  )
  registry.register(cmd("quit", { aliases: ["exit", "q"], description: "Leave" }), "test")
  registry.register(
    cmd("model", {
      description: "Switch",
      args: { complete: (_p, ctx) => ctx.session.models().map((value) => ({ value })) },
    }),
    "test",
  )
  expect((await host.complete("/ex")).candidates).toEqual([
    { value: "quit", description: "Leave", label: "quit (exit, q)" },
  ])
  expect((await host.complete("/")).candidates.map((c) => c.label ?? c.value)).toEqual([
    "ds → /model deepseek/deepseek-flash",
    "m → /model",
    "model",
    "quit (exit, q)",
    "zz → /nothing",
  ])
  expect((await host.complete("/zz")).candidates).toEqual([
    { value: "zz", label: "zz → /nothing", description: "not a command" },
  ])
  // Arguments complete for the command an alias runs, unless the alias fixes them.
  expect(await host.complete("/m flash")).toEqual({
    command: "model",
    candidates: [{ value: "deepseek/deepseek-flash" }],
  })
  expect(await host.complete("/ds x")).toEqual({ command: "model", candidates: [] })
  expect(await host.complete("/exit x")).toEqual({ command: "quit", candidates: [] })
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
