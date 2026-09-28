import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { AnyEvent, SessionControl } from "@amira/api"
import { Agent, CommandHost, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { createSkillsExtension, discoverSkills, parseFrontmatter, skillsSection } from "../src/index.ts"

const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-skills-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let n = 0
function layout() {
  const base = path.join(tmp, `case${n++}`)
  const dirs = {
    cwd: path.join(base, "project"),
    home: path.join(base, "amira-home"),
    userHome: path.join(base, "user"),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  return dirs
}

function skill(root: string, dir: string, front: string, body = "Do the thing.") {
  mkdirSync(path.join(root, dir), { recursive: true })
  writeFileSync(path.join(root, dir, "SKILL.md"), `---\n${front}\n---\n${body}\n`)
}

test("frontmatter: YAML fields and body, tolerant of BOM, CRLF and no frontmatter", () => {
  expect(parseFrontmatter("﻿---\r\nname: a\r\ndescription: 'x: y'\r\n---\r\nbody\r\n")).toEqual({
    data: { name: "a", description: "x: y" },
    body: "body\r\n",
  })
  expect(parseFrontmatter("just text")).toEqual({ data: {}, body: "just text" })
  expect(parseFrontmatter("---\n---\nbody")).toEqual({ data: {}, body: "body" })
  expect(() => parseFrontmatter("---\nname: [unclosed\n---\n")).toThrow()
})

test("discovers skills in all five directories; Amira's directories win name clashes", () => {
  const d = layout()
  skill(path.join(d.cwd, ".amira", "skills"), "shared", "name: shared\ndescription: from project amira")
  skill(path.join(d.home, "skills"), "shared", "name: shared\ndescription: from user amira")
  skill(path.join(d.home, "skills"), "mine", "name: mine\ndescription: user amira only")
  skill(path.join(d.cwd, ".agents", "skills"), "mine", "name: mine\ndescription: shadowed by amira")
  skill(path.join(d.cwd, ".agents", "skills"), "agents", "description: name from the directory")
  skill(
    path.join(d.cwd, ".claude", "skills"),
    "claude-proj",
    "name: claude-proj\ndescription: project claude",
  )
  skill(
    path.join(d.userHome, ".claude", "skills"),
    "claude-user",
    "name: claude-user\ndescription: >\n  folded\n  text",
  )
  skill(path.join(d.userHome, ".claude", "skills"), "dup", "name: shared\ndescription: loses to amira")
  const { skills, problems } = discoverSkills(d)
  expect(problems).toEqual([])
  expect(skills.map((s) => [s.name, s.description])).toEqual([
    ["agents", "name from the directory"],
    ["claude-proj", "project claude"],
    ["claude-user", "folded text"],
    ["mine", "user amira only"],
    ["shared", "from project amira"],
  ])
  const shared = skills.find((s) => s.name === "shared")!
  expect(shared.path).toBe(path.join(d.cwd, ".amira", "skills", "shared", "SKILL.md"))
  expect(shared.dir).toBe(path.join(d.cwd, ".amira", "skills", "shared"))
})

test("reports broken skills and skips folders without SKILL.md", () => {
  const d = layout()
  const root = path.join(d.cwd, ".amira", "skills")
  skill(root, "nodesc", "name: nodesc")
  skill(root, "badyaml", "name: [oops")
  skill(root, "ok", "name: ok\ndescription: fine\nallowed-tools: [read]")
  mkdirSync(path.join(root, "empty"), { recursive: true })
  const { skills, problems } = discoverSkills(d)
  expect(skills.map((s) => s.name)).toEqual(["ok"])
  expect(skills[0]!.meta["allowed-tools"]).toEqual(["read"])
  expect(problems.length).toBe(2)
  expect(problems.find((p) => p.includes("nodesc"))).toContain("missing description")
  expect(problems.find((p) => p.includes("badyaml"))).toContain("invalid frontmatter")
})

test("the prompt section lists one line per model-usable skill", () => {
  const d = layout()
  const root = path.join(d.cwd, ".amira", "skills")
  skill(root, "a", "name: a\ndescription: first")
  skill(root, "hidden", "name: hidden\ndescription: user only\ndisable-model-invocation: true")
  const { skills } = discoverSkills(d)
  expect(skillsSection(skills).split("\n").slice(2)).toEqual([
    `- a: first (${path.join(root, "a", "SKILL.md")})`,
  ])
  expect(skillsSection(skills.filter((s) => s.name === "hidden"))).toBe("")
})

async function run(d: ReturnType<typeof layout>, steps: MockStep[]) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, cwd: d.cwd })
  await host.load(createSkillsExtension({ home: d.home, userHome: d.userHome }), "builtin:skills")
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: d.cwd,
    systemPrompt: "sys",
    bus,
    interceptors,
    tools,
  })
  await agent.prompt("go")
  await bus.flush()
  return { mock, events, agent }
}

test("the skill tool loads a skill's instructions; the listing goes into the system prompt", async () => {
  const d = layout()
  const root = path.join(d.home, "skills")
  skill(root, "deploy", "name: deploy\ndescription: Ship it", "# Deploy\nRun ./ship.sh")
  const { mock } = await run(d, [
    { toolCalls: [{ id: "c1", name: "skill", args: { name: "deploy", args: "prod" } }] },
    { text: "ok" },
  ])
  const req = mock.requests[0]!
  expect(req.tools.map((t) => t.name)).toEqual(["skill"])
  expect(req.systemPrompt).toContain(`# Skills\n`)
  expect(req.systemPrompt).toContain(`- deploy: Ship it (${path.join(root, "deploy", "SKILL.md")})`)
  const result = mock.requests[1]!.messages.at(-1)!
  expect(result).toMatchObject({ role: "toolResult", isError: false })
  const text = JSON.stringify(result)
  expect(text).toContain(`base directory: ${path.join(root, "deploy")}`.replaceAll("\\", "\\\\"))
  expect(text).toContain("# Deploy\\nRun ./ship.sh")
  expect(text).toContain("Arguments: prod")
  expect(text).not.toContain("description: Ship it")
})

test("no skills: no tool and no prompt block; broken skills are reported", async () => {
  const d = layout()
  skill(path.join(d.cwd, ".claude", "skills"), "broken", "name: broken")
  const { mock, events } = await run(d, [{ text: "ok" }])
  expect(mock.requests[0]!.tools).toEqual([])
  expect(mock.requests[0]!.systemPrompt).toBe("sys")
  const err = events.find((e) => e.type === "extension.error")
  expect(err?.data).toMatchObject({ source: "builtin:skills" })
  expect(JSON.stringify(err?.data)).toContain("missing description")
})

test("skills written during a session are listed and usable from the next model call", async () => {
  const d = layout()
  const project = path.join(d.cwd, ".amira", "skills")
  const { mock, agent, events } = await run(d, [{ text: "one" }, { text: "two" }, { text: "three" }])
  expect(mock.requests[0]!.tools).toEqual([])
  expect(mock.requests[0]!.systemPrompt).toBe("sys")

  skill(project, "deploy", "description: Ship it")
  await agent.prompt("again")
  expect(mock.requests[1]!.tools.map((t) => t.name)).toEqual(["skill"])
  expect(mock.requests[1]!.systemPrompt).toContain("- deploy: Ship it")

  skill(project, "review", "description: Review it")
  skill(project, "bad", "name: bad")
  await agent.prompt("third")
  expect(mock.requests[2]!.tools.map((t) => t.name)).toEqual(["skill"])
  expect(mock.requests[2]!.systemPrompt).toContain("- deploy: Ship it")
  expect(mock.requests[2]!.systemPrompt).toContain("- review: Review it")
  await agent.bus.flush()
  // A broken skill is reported once, not on every model call.
  expect(events.filter((e) => e.type === "extension.error")).toHaveLength(1)
})

test("settings skills.dirs adds directories, and the listing fills the prompt's skills section", async () => {
  const d = layout()
  skill(path.join(d.cwd, "team-skills"), "lint", "name: lint\ndescription: Lint it")
  skill(path.join(d.userHome, "more"), "fmt", "name: fmt\ndescription: Format it")
  expect(discoverSkills({ ...d, dirs: ["team-skills", "~/more"] }).skills.map((s) => s.name)).toEqual([
    "fmt",
    "lint",
  ])

  const mock = createMockDialect([{ text: "ok" }])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const settings = { skills: { dirs: ["team-skills"] } }
  const host = new ExtensionHost({ bus, interceptors, tools, cwd: d.cwd, settings })
  await host.load(createSkillsExtension({ home: d.home, userHome: d.userHome }), "builtin:skills")
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: d.cwd,
    sections: [
      { name: "identity", text: "sys" },
      { name: "skills", text: "" },
      { name: "role", text: "# Role" },
    ],
    bus,
    interceptors,
    tools,
  })
  await agent.prompt("go")
  const prompt = mock.requests[0]!.systemPrompt
  expect(prompt.startsWith("sys\n\n# Skills\n")).toBe(true)
  expect(prompt).toContain("- lint: Lint it")
  expect(prompt.endsWith("\n\n# Role")).toBe(true)
})

test("every skill is a slash command that sends its instructions, user-only ones too", async () => {
  const d = layout()
  const root = path.join(d.home, "skills")
  skill(root, "deploy", "name: deploy\ndescription: Ship it", "# Deploy\nRun ./ship.sh")
  skill(root, "secret", "name: secret\ndescription: Only for me\ndisable-model-invocation: true")
  skill(root, "help", "name: help\ndescription: Clashes with a command")
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd: d.cwd,
  })
  await host.load((api) => {
    api.registerCommand({ name: "help", description: "built-in", run: () => {} })
  }, "builtin:commands")
  await host.load(createSkillsExtension({ home: d.home, userHome: d.userHome }), "builtin:skills")
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: d.cwd, bus })
  const sent: string[] = []
  const control = { send: async (text: string) => void sent.push(text) } as Partial<SessionControl>
  const commands = new CommandHost({
    registry: host.commands,
    bus,
    ui: host.ui,
    control: control as SessionControl,
    agent,
  })
  expect(commands.list().map((c) => [c.name, c.description, c.source])).toEqual([
    ["deploy", "Skill: Ship it", "builtin:skills"],
    ["help", "built-in", "builtin:commands"],
    ["secret", "Skill: Only for me", "builtin:skills"],
  ])
  expect((await commands.run("/deploy to prod", { frontend: "tui" })).ok).toBe(true)
  expect(sent[0]).toContain(`Skill "deploy" (base directory: ${path.join(root, "deploy")})`)
  expect(sent[0]).toContain("# Deploy\nRun ./ship.sh")
  expect(sent[0]).toContain("Arguments: to prod")
  await commands.run("/secret", { frontend: "tui" })
  expect(sent[1]).toContain('Skill "secret"')
  await bus.flush()
  expect(events.find((e) => e.type === "extension.error")?.data.error).toContain(
    "command /help from builtin:skills conflicts",
  )
})
