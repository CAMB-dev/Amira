import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { ExtensionAPI, Settings } from "@amira/api"
import { parseCliArgs, USAGE } from "../src/args.ts"
import { resolveConfig } from "../src/config.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

let home: string
let cwd: string
let savedHome: string | undefined

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-thinking-cli-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home)
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
})

const levels = ["low", "medium", "high", "xhigh", "max"] as const

test.each([...levels])("--thinking accepts %s in print and interactive mode", (thinking) => {
  expect(parseCliArgs(["--thinking", thinking], cwd, {}).thinking).toBe(thinking)
  expect(parseCliArgs(["-p", `--thinking=${thinking}`, "hello"], cwd, {}).thinking).toBe(thinking)
})

test("--thinking lists all levels on invalid or missing input, and in help", () => {
  for (const flags of [["--thinking", "ultra"], ["--thinking="], ["--thinking"]]) {
    expect(() => parseCliArgs(flags, cwd, {})).toThrow(/low, medium, high, xhigh.*max/)
  }
  expect(USAGE).toContain("--thinking <level>")
  expect(USAGE).toContain("low, medium, high, xhigh or max")
  expect(parseCliArgs([], cwd, {}).thinking).toBeUndefined()
})

async function sessionFor(flags: string[], settings: Settings = {}, thinks = true) {
  writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings))
  const args = parseCliArgs(flags, cwd, {})
  const config = resolveConfig(args, home)
  const mock = createMockDialect(Array.from({ length: 8 }, () => ({ text: "done" })))
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { caps: { thinking: thinks } } }],
    retry: { retries: 0 },
  })
  const session = await createSession({
    ai,
    model: "mock/m",
    cwd,
    extensions: [],
    noBuiltins: true,
    nonInteractive: args.print,
    settings: config.settings,
    settingsLayers: config.settingsLayers,
  })
  const commands = createCommandHost({ session, cwd, home })
  return { session, mock, config, commands }
}

test.each([false, true])(
  "settings and flag precedence reach requests and status (print=%s)",
  async (print) => {
    const settings: Settings = {
      thinking: "low",
      providers: {
        mock: { dialect: "mock", baseUrl: "http://mock", models: [{ id: "m", thinking: "high" }] },
      },
    }
    const mode = print ? ["-p", "hello"] : []
    for (const [flags, expected] of [
      [mode, "high"],
      [[...mode, "--thinking", "max"], "max"],
    ] as const) {
      const { session, mock, commands } = await sessionFor([...flags], settings)
      try {
        await session.agent.prompt("hello")
        expect(mock.requests[0]?.reasoning).toEqual({ effort: expected })
        expect(commands.control.info().thinking).toBe(expected)
        commands.control.setModel("mock/other")
        await session.agent.prompt("again")
        const fallback = expected === "max" ? "max" : "low"
        expect(mock.requests[1]?.reasoning).toEqual({ effort: fallback })
        expect(commands.control.info().thinking).toBe(fallback)
        const child = session.tree.spawn(session.agent, { prompt: "child", model: "mock/m" })
        expect((await child.result()).status).toBe("done")
        expect(mock.requests[2]?.reasoning).toEqual({ effort: fallback })
      } finally {
        await session.agent.dispose()
        session.host.unloadAll()
      }
    }
  },
)

test("project layers override user thinking, then --thinking overrides them", async () => {
  writeFileSync(path.join(cwd, ".amira", "settings.json"), JSON.stringify({ thinking: "medium" }))
  writeFileSync(path.join(cwd, ".amira", "settings.local.json"), JSON.stringify({ thinking: "xhigh" }))
  for (const flags of [[], ["--thinking", "max"]]) {
    const { session, mock, config } = await sessionFor(flags, { thinking: "low" })
    try {
      const expected = flags.length ? "max" : "xhigh"
      expect(config.settings.thinking).toBe(expected)
      await session.agent.prompt("hello")
      expect(mock.requests[0]?.reasoning).toEqual({ effort: expected })
    } finally {
      await session.agent.dispose()
      session.host.unloadAll()
    }
  }
})

test("unset effort sends nothing and stays absent from session info", async () => {
  const { session, mock, commands } = await sessionFor([])
  try {
    await session.agent.prompt("hello")
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]).not.toHaveProperty("reasoning")
    expect(commands.control.info()).not.toHaveProperty("thinking")
  } finally {
    await session.agent.dispose()
    session.host.unloadAll()
  }
})

test("api.complete side calls do not inherit thinking", async () => {
  const { session, mock } = await sessionFor(["--thinking", "max"])
  let api: ExtensionAPI | undefined
  await session.host.load((extensionApi) => {
    api = extensionApi
  }, "test:side")
  try {
    await session.agent.prompt("hello")
    await api!.complete({ messages: [userMessage("Name this session")], label: "title" })
    expect(mock.requests).toHaveLength(2)
    expect(mock.requests[0]?.reasoning).toEqual({ effort: "max" })
    expect(mock.requests[1]).not.toHaveProperty("reasoning")
  } finally {
    await session.agent.dispose()
    session.host.unloadAll()
  }
})

test("status hides an effort the current model would not be sent", async () => {
  const { session, mock, commands } = await sessionFor(["--thinking", "high"], {}, false)
  try {
    await session.agent.prompt("hello")
    expect(mock.requests[0]).not.toHaveProperty("reasoning")
    expect(commands.control.info()).not.toHaveProperty("thinking")
  } finally {
    await session.agent.dispose()
    session.host.unloadAll()
  }
})
