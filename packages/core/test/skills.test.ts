import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, SessionControl, SkillDefinition } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { CommandHost, CommandRegistry } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { parseSkillLine, SkillConflictError, SkillRegistry } from "../src/skills.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

const skill = (name: string, extra: Partial<SkillDefinition> = {}): SkillDefinition => ({
  name,
  description: `the ${name} skill`,
  run: () => {},
  ...extra,
})

function setup() {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
  const registry = new CommandRegistry()
  const skills = new SkillRegistry()
  const host = new CommandHost({
    registry,
    skills,
    bus,
    ui: new UiRequests(bus),
    control: {} as SessionControl,
    agent,
  })
  const outputs = async () => {
    await bus.flush()
    return events.flatMap((e) => (e.type === "command.output" ? [e.data] : []))
  }
  return { registry, skills, host, outputs }
}

test("the registry refuses a taken name without override and restores the one below on removal", () => {
  const r = new SkillRegistry()
  r.register(skill("deploy"), "a")
  expect(() => r.register(skill("deploy"), "b")).toThrow(SkillConflictError)
  const off = r.register(skill("deploy", { description: "better", override: true }), "b")
  expect(r.list()).toEqual([{ name: "deploy", description: "better", hint: "[arguments]", source: "b" }])
  off()
  expect(r.get("deploy")?.source).toBe("a")
  expect(() => r.register(skill("two words"), "a")).toThrow("invalid skill name")
  expect(() => r.register(skill("a$b"), "a")).toThrow("invalid skill name")
})

test("a skill line is $name and arguments", () => {
  expect(parseSkillLine("$deploy")).toEqual({ name: "deploy", args: "" })
  expect(parseSkillLine("  $deploy  to prod\nnow ")).toEqual({ name: "deploy", args: "to prod\nnow" })
  expect(parseSkillLine("$")).toBeUndefined()
  expect(parseSkillLine("$ deploy")).toBeUndefined()
  expect(parseSkillLine("deploy")).toBeUndefined()
})

test("only a line naming a registered skill runs one; other $ text is a message", () => {
  const { skills, host } = setup()
  skills.register(skill("deploy"), "ext")
  expect(host.skillLine("$deploy to prod")).toEqual({ name: "deploy", args: "to prod" })
  expect(host.skillLine("$100 is the price")).toBeUndefined()
  expect(host.skillLine("$HOME is empty")).toBeUndefined()
  expect(host.skillLine("/deploy")).toBeUndefined()
})

test("skill completion ranks names by prefix, then fuzzily; arguments have no candidates", () => {
  const { skills, host } = setup()
  skills.register(skill("review-pr"), "ext")
  skills.register(skill("deploy"), "ext")
  skills.register(skill("debug"), "ext")
  const names = (line: string) => host.completeSkill(line).candidates.map((c) => c.value)
  expect(names("$")).toEqual(["debug", "deploy", "review-pr"])
  expect(names("$de")).toEqual(["debug", "deploy"])
  expect(names("$rpr")).toEqual(["review-pr"])
  expect(host.completeSkill("$deploy")).toEqual({
    candidates: [{ value: "deploy", description: "the deploy skill" }],
  })
  expect(host.completeSkill("$deploy to")).toEqual({ command: "deploy", candidates: [] })
  expect(host.completeSkill("$100 is")).toEqual({ candidates: [] })
})

test("running a skill hands it the arguments; unknown ones and failures are reported", async () => {
  const { skills, host, outputs } = setup()
  let seen: { args: string; frontend: string; skills: string[] } | undefined
  skills.register(
    skill("deploy", {
      run: (args, ctx) => {
        seen = { args, frontend: ctx.frontend, skills: ctx.skills().map((s) => s.name) }
        ctx.print("shipped")
      },
    }),
    "ext",
  )
  skills.register(
    skill("broken", {
      run: () => {
        throw new Error("no luck")
      },
    }),
    "ext",
  )
  expect(await host.runSkill("$deploy to prod", { frontend: "rpc" })).toEqual({
    ok: true,
    command: "deploy",
    output: ["shipped"],
  })
  expect(seen).toEqual({ args: "to prod", frontend: "rpc", skills: ["broken", "deploy"] })
  expect(await host.runSkill("$nope", { frontend: "rpc" })).toMatchObject({
    ok: false,
    command: "nope",
    error: "Unknown skill $nope. Type $ to list the skills.",
  })
  expect(await host.runSkill("$broken", { frontend: "rpc" })).toMatchObject({ ok: false, error: "no luck" })
  expect((await outputs()).map((o) => [o.command, o.text])).toEqual([
    ["$deploy", "shipped"],
    ["$nope", "Unknown skill $nope. Type $ to list the skills."],
    ["$broken", "no luck"],
  ])
})

test("/<skill> runs no skill and points at $; a command of that name still wins", async () => {
  const { registry, skills, host } = setup()
  let ran = 0
  skills.register(skill("deploy", { run: () => void ran++ }), "ext")
  skills.register(skill("help", { run: () => void ran++ }), "ext")
  registry.register({ name: "help", description: "help", run: () => {} }, "builtin")
  expect(await host.run("/deploy", { frontend: "tui" })).toMatchObject({
    ok: false,
    error: "Unknown command /deploy — skills now start with $: $deploy",
  })
  expect((await host.run("/help", { frontend: "tui" })).ok).toBe(true)
  expect(ran).toBe(0)
  expect(host.list().map((c) => c.name)).toEqual(["help"])
})

test("extensions register skills through the API; a taken name is reported and skipped", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load((api) => void api.registerSkill(skill("deploy")), "a")
  expect(await host.load((api) => void api.registerSkill(skill("deploy")), "b")).toBe(true)
  expect(host.skills.list().map((s) => [s.name, s.source])).toEqual([["deploy", "a"]])
  await bus.flush()
  expect(events.find((e) => e.type === "extension.error")?.data).toMatchObject({
    source: "b",
    error: expect.stringContaining("skill $deploy from b conflicts"),
  })
  host.unload("a")
  expect(host.skills.list()).toEqual([])
})
