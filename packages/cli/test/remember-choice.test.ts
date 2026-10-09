import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, isNoModel } from "@amira/ai"
import type { ExtensionAPI } from "@amira/api"
import { Agent } from "@amira/core"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { parseCliArgs } from "../src/args.ts"
import { resolveConfig } from "../src/config.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession, type Session } from "../src/session.ts"

let root: string
let home: string
let cwd: string
let savedHome: string | undefined
const sessions: Session[] = []
const globalFile = () => path.join(home, "settings.json")
const localFile = () => path.join(cwd, ".amira", "settings.local.json")
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "amira-remember-"))
  home = path.join(root, "home")
  cwd = path.join(root, "project")
  mkdirSync(home)
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
})

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.agent.dispose()
    session.host.unloadAll()
  }
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

async function start(flags: string[] = [], directory = cwd) {
  const args = parseCliArgs(flags, directory, {})
  const config = resolveConfig(args, home)
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [
      {
        id: "mock",
        dialect: "mock",
        baseUrl: "",
        models: [
          { id: "first", caps: { thinking: true } },
          { id: "second", caps: { thinking: true } },
        ],
      },
    ],
  })
  const session = await createSession({
    ai,
    model: config.settings.model,
    cwd: directory,
    settings: config.settings,
    settingsLayers: config.settingsLayers,
    extensions: [],
    noBuiltins: false,
    nonInteractive: args.print,
    builtins: async () => [{ source: "builtin:commands", extension: commandsExtension }],
  })
  sessions.push(session)
  const commands = createCommandHost({
    session,
    cwd: directory,
    home,
    interactive: !args.print && !args.rpc,
    aliases: { fast: "model mock/second" },
  })
  return { session, commands, config }
}

test("interactive commands save both choices immediately, and the last change wins", async () => {
  const { commands } = await start()
  expect((await commands.run("/fast", { frontend: "tui" })).ok).toBe(true)
  for (const file of [globalFile(), localFile()]) {
    expect(json(file)).toEqual({ model: "mock/second", thinking: "default" })
  }
  expect((await commands.run("/thinking high", { frontend: "tui" })).ok).toBe(true)
  expect(json(localFile()).thinking).toBe("high")
  commands.control.setThinking("max")
  commands.control.setModel("mock/first")
  for (const file of [globalFile(), localFile()]) {
    expect(json(file)).toEqual({ model: "mock/first", thinking: "max" })
  }
})

test("picker selections use the same remembered interactive controls", async () => {
  const { session, commands } = await start()
  const picks = ["mock/second", "high"]
  session.agent.bus.subscribe((event) => {
    if (event.type === "ui.request" && event.data.kind === "select") {
      const pick = picks.shift()!
      const option = event.data.options.find((option) => option.startsWith(pick))!
      session.host.ui.respond(event.data.requestId, option)
    }
  })
  expect((await commands.run("/model", { frontend: "tui" })).ok).toBe(true)
  expect(json(localFile())).toEqual({ model: "mock/second", thinking: "high" })
  expect(json(globalFile())).toEqual(json(localFile()))
})

test("project choices survive global changes; a new project falls back to the global choice", async () => {
  const first = await start()
  first.commands.control.setModel("mock/second")
  first.commands.control.setThinking("high")
  const other = path.join(root, "other")
  mkdirSync(path.join(other, ".amira"), { recursive: true })
  const second = await start([], other)
  expect(second.commands.control.info()).toMatchObject({
    model: { provider: "mock", model: "second" },
    thinkingLevel: "high",
  })
  second.commands.control.setModel("mock/first")
  second.commands.control.setThinking("low")
  const restarted = await start()
  expect(restarted.commands.control.info()).toMatchObject({
    model: { provider: "mock", model: "second" },
    thinkingLevel: "high",
  })
  expect((await start([], other)).commands.control.info().thinkingLevel).toBe("low")
})

test("flags and env are one-off until an actual interactive change", async () => {
  writeFileSync(globalFile(), '{"model":"mock/first","thinking":"low"}')
  const original = readFileSync(globalFile(), "utf8")
  const { commands } = await start(["-m", "mock/second", "--thinking", "max"])
  expect(commands.control.info().thinkingLevel).toBe("max")
  expect(commands.control.info().model.model).toBe("second")
  expect(readFileSync(globalFile(), "utf8")).toBe(original)
  expect(existsSync(localFile())).toBe(false)
  commands.control.setModel("mock/second")
  commands.control.setThinking("max")
  expect(existsSync(localFile())).toBe(false)
  commands.control.setThinking("high")
  expect(json(localFile())).toEqual({ model: "mock/second", thinking: "high" })
  const envArgs = parseCliArgs([], cwd, { AMIRA_MODEL: "mock/first" })
  expect(resolveConfig(envArgs, home).settings.model).toBe("mock/first")
  expect(
    resolveConfig(parseCliArgs(["-m", "mock/second"], cwd, { AMIRA_MODEL: "mock/first" }), home).settings
      .model,
  ).toBe("mock/second")
})

test.each(["-p", "--rpc"])("%s controls never save model or effort", async (mode) => {
  const flags = [mode, "-m", "mock/first", "--thinking", "low"]
  if (mode === "-p") flags.push("hello")
  const { commands } = await start(flags)
  commands.control.setModel("mock/second")
  commands.control.setThinking("max")
  expect(existsSync(globalFile())).toBe(false)
  expect(existsSync(localFile())).toBe(false)
})

test("extensions and child agents never save, even in an interactive host", async () => {
  const { session, commands } = await start()
  let api: ExtensionAPI | undefined
  await session.host.load((extensionApi) => {
    api = extensionApi
  }, "test:programmatic")
  api!.session()!.setModel("mock/second")
  api!.session()!.setThinking("high")
  session.agent.setModel(session.ai.model("mock/first"))
  expect(existsSync(globalFile())).toBe(false)
  const child = new Agent({
    ai: session.ai,
    model: session.ai.model("mock/first"),
    cwd,
    tree: session.tree,
    parentSessionId: session.agent.sessionId,
  })
  commands.switchTo(child)
  try {
    commands.control.setModel("mock/second")
    commands.control.setThinking("max")
    expect(existsSync(globalFile())).toBe(false)
    expect(existsSync(localFile())).toBe(false)
  } finally {
    await child.dispose()
  }
})

test("default effort is remembered instead of exposing a lower project setting", async () => {
  writeFileSync(path.join(cwd, ".amira", "settings.json"), '{"thinking":"high"}')
  const { commands } = await start()
  commands.control.setThinking(undefined)
  expect(json(localFile()).thinking).toBe("default")
  expect(json(globalFile()).thinking).toBe("default")
  expect((await start()).commands.control.info()).not.toHaveProperty("thinkingLevel")
})

test("existing keys, nested formatting, order, BOM and CRLF are preserved", async () => {
  const original =
    '\uFEFF{\r\n\t"custom": { "nested" : [1, {"model":"not-a-setting"}] },\r\n\t"model" : "mock/first",\r\n\t"thinking": "low",\r\n\t"shell": "auto"\r\n}\r\n'
  for (const file of [globalFile(), localFile()]) writeFileSync(file, original)
  const { commands } = await start()
  commands.control.setModel("mock/second")
  commands.control.setThinking("max")
  for (const file of [globalFile(), localFile()]) {
    expect(readFileSync(file, "utf8")).toBe(
      original.replace('"mock/first"', '"mock/second"').replace('"low"', '"max"'),
    )
  }
})

test.each(["{invalid", "null", "[]"])(
  "invalid settings %s stay untouched; the other file still saves",
  async (invalid) => {
    const { session, commands } = await start()
    const warnings: string[] = []
    session.agent.bus.subscribe((event) => {
      if (event.type === "extension.error" && event.data.source === "settings")
        warnings.push(event.data.error)
    })
    writeFileSync(localFile(), invalid)
    commands.control.setThinking("high")
    await session.agent.bus.flush()
    expect(readFileSync(localFile(), "utf8")).toBe(invalid)
    expect(json(globalFile()).thinking).toBe("high")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Choice not saved:")
    expect(warnings[0]).not.toContain("\n")
    writeFileSync(globalFile(), invalid)
    rmSync(localFile())
    commands.control.setThinking("low")
    expect(readFileSync(globalFile(), "utf8")).toBe(invalid)
    expect(json(localFile()).thinking).toBe("low")
  },
)

test.each(["bare", "user"])("no project (%s) only saves globally", async (scope) => {
  const directory = path.join(root, scope)
  mkdirSync(directory)
  if (scope === "user") {
    home = path.join(directory, ".amira")
    mkdirSync(home)
    process.env.AMIRA_HOME = home
  }
  const { commands } = await start([], directory)
  commands.control.setThinking("max")
  expect(json(globalFile()).thinking).toBe("max")
  expect(existsSync(path.join(directory, ".amira", "settings.local.json"))).toBe(false)
  if (scope === "bare") expect(existsSync(path.join(directory, ".amira"))).toBe(false)
})

test("repository project choices must be ignored and untracked; scope stays at cwd", async () => {
  execFileSync("git", ["init", "--quiet", cwd])
  const { session, commands } = await start()
  const warnings: string[] = []
  session.agent.bus.subscribe((event) => {
    if (event.type === "extension.error") warnings.push(event.data.error)
  })
  commands.control.setThinking("high")
  await session.agent.bus.flush()
  expect(existsSync(localFile())).toBe(false)
  expect(json(globalFile()).thinking).toBe("high")
  expect(warnings.some((warning) => warning.includes("keep it untracked"))).toBe(true)
  writeFileSync(path.join(cwd, ".gitignore"), "**/.amira/settings.local.json\n")
  commands.control.setThinking("max")
  expect(json(localFile()).thinking).toBe("max")
  execFileSync("git", ["-C", cwd, "add", "--force", ".amira/settings.local.json"])
  commands.control.setThinking("low")
  expect(json(localFile()).thinking).toBe("max")
  const nested = path.join(cwd, "nested")
  mkdirSync(nested)
  const inner = await start([], nested)
  inner.commands.control.setThinking("high")
  expect(json(path.join(nested, ".amira", "settings.local.json")).thinking).toBe("high")
  expect(json(localFile()).thinking).toBe("max")
})

test("a remembered missing provider uses the stored-session fallback without deleting the key", async () => {
  writeFileSync(localFile(), '{"model":"removed/model","thinking":"high"}')
  const original = readFileSync(localFile(), "utf8")
  const { session } = await start()
  expect(session.agent.model.id).toBe("first")
  expect(readFileSync(localFile(), "utf8")).toBe(original)
  const empty = await createSession({
    ai: createAi({ providers: [] }),
    model: "removed/model",
    settings: { model: "removed/model" },
    cwd,
    extensions: [],
    noBuiltins: true,
  })
  sessions.push(empty)
  expect(isNoModel(empty.agent.model)).toBe(true)
  expect(empty.modelNotice).toBe(
    "No providers configured — add one with /provider add, then pick a model with /model.",
  )
  expect(readFileSync(localFile(), "utf8")).toBe(original)
  await expect(start(["-m", "removed/model"])).rejects.toThrow(/removed/)
})
