import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseCliArgs, UsageError } from "../src/args.ts"
import { resolveConfig } from "../src/config.ts"
import { runProviderCommand } from "../src/provider-command.ts"
import { createSession, retryFromSettings } from "../src/session.ts"

let dir: string
let home: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-cli-config-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value))
const config = (argv: string[], env: Record<string, string> = {}, platform = "win32") =>
  resolveConfig(parseCliArgs([...argv, "-C", cwd, "hi"], dir, env), home, platform)

function capture() {
  const c = {
    out: "",
    err: "",
    stdout: (s: string) => {
      c.out += s
    },
    stderr: (s: string) => {
      c.err += s
    },
  }
  return c
}

test("the model comes from --model, then $AMIRA_MODEL, then settings", () => {
  put(path.join(home, "settings.json"), { model: "user/m" })
  expect(config([]).settings.model).toBe("user/m")
  put(path.join(cwd, ".amira", "settings.json"), { model: "project/m" })
  expect(config([]).settings.model).toBe("project/m")
  expect(config([], { AMIRA_MODEL: "env/m" }).settings.model).toBe("env/m")
  expect(config(["-m", "flag/m"], { AMIRA_MODEL: "env/m" }).settings.model).toBe("flag/m")
})

test("shell and tools.disabled come from settings unless the flags are given", () => {
  put(path.join(cwd, ".amira", "settings.json"), { shell: "bash", tools: { disabled: ["glob"] } })
  expect(config([]).disabledTools.sort()).toEqual(["glob", "powershell"])
  expect(config(["--shell", "powershell"]).disabledTools.sort()).toEqual(["bash", "glob"])
  expect(config(["--disable-tools", "grep"]).disabledTools.sort()).toEqual(["grep", "powershell"])
  expect(config(["--shell", "auto", "--disable-tools", ""]).disabledTools).toEqual([])
})

test("the names to check for unknown tools come from the flag or, without it, from settings", () => {
  put(path.join(cwd, ".amira", "settings.json"), { shell: "bash", tools: { disabled: ["glob"] } })
  expect(config([]).requestedDisabled).toEqual({ names: ["glob"], from: "settings tools.disabled" })
  expect(config(["--disable-tools", "grep"]).requestedDisabled).toEqual({
    names: ["grep"],
    from: "--disable-tools",
  })
})

test("a powershell shell from settings falls back to auto off Windows, with a warning", () => {
  put(path.join(home, "settings.json"), { shell: "powershell" })
  const c = config([], {}, "linux")
  expect(c.disabledTools).toEqual([])
  expect(c.warnings[0]).toContain("only available on Windows")
})

test("providers, maxParallelTools and auth keys come through", () => {
  put(path.join(home, "settings.json"), {
    maxParallelTools: 3,
    retry: { attempts: 5 },
    providers: { mine: { dialect: "openai-chat", baseUrl: "http://mine", apiKeyEnv: "MINE_KEY" } },
  })
  put(path.join(home, "auth.json"), { mine: { apiKey: "stored" } })
  const c = config([])
  expect(c.settings.maxParallelTools).toBe(3)
  expect(c.providers).toEqual([
    { id: "mine", dialect: "openai-chat", baseUrl: "http://mine", apiKeyEnv: "MINE_KEY" },
  ])
  expect(c.apiKeys).toEqual({ mine: "stored" })
})

test("settings reach the session: extensions, retry hook and model lookup", async () => {
  let seen: unknown
  const session = await createSession({
    model: "mine/m",
    cwd,
    extensions: [],
    noBuiltins: false,
    catalog: false,
    builtins: async () => [
      {
        source: "t",
        extension: (api) => {
          seen = api.settings.skills
        },
      },
    ],
    settings: { skills: { dirs: ["s"] }, retry: { attempts: 4 }, maxParallelTools: 2 },
    providers: [{ id: "mine", dialect: "openai-chat", baseUrl: "http://mine" }],
  })
  expect(seen).toEqual({ dirs: ["s"] })
  expect(session.agent.model.provider).toBe("mine")
  expect(session.agent.maxParallelTools).toBe(2)
  const plain = await createSession({
    model: "mine/m",
    cwd,
    extensions: [],
    noBuiltins: true,
    catalog: false,
    providers: [{ id: "mine", dialect: "openai-chat", baseUrl: "http://mine" }],
  })
  expect(plain.agent.maxParallelTools).toBe(8)
})

test("settings retry becomes the ai layer's retry options", () => {
  expect(retryFromSettings(undefined)).toBeUndefined()
  expect(retryFromSettings({})).toBeUndefined()
  expect(retryFromSettings({ attempts: 0 })).toEqual({ retries: 0 })
  expect(retryFromSettings({ attempts: 5, baseDelayMs: 200, maxDelayMs: 10_000 })).toEqual({
    retries: 5,
    baseDelayMs: 200,
    maxDelayMs: 10_000,
  })
})

test("settings compact sets the agent's threshold and summary model", async () => {
  const providers = [
    {
      id: "mine",
      dialect: "openai-chat" as const,
      baseUrl: "http://mine",
      models: [{ id: "m" }, { id: "small" }],
    },
  ]
  const base = { cwd, extensions: [], noBuiltins: true, catalog: false as const, providers }
  const session = await createSession({
    ...base,
    model: "mine/m",
    settings: { compact: { threshold: 0.5, model: "mine/small" } },
  })
  expect(session.agent.compaction.threshold).toBe(0.5)
  expect(session.agent.compaction.model?.id).toBe("small")
  const plain = await createSession({ ...base, model: "mine/m" })
  expect(plain.agent.compaction).toEqual({})
  const err = await createSession({
    ...base,
    model: "mine/m",
    settings: { compact: { model: "nope/x" } },
  }).catch((e) => e)
  expect(err).toBeInstanceOf(UsageError)
})

test("settings warnings become startup events for the interactive UI", async () => {
  const session = await createSession({
    model: "mine/m",
    cwd,
    extensions: [],
    noBuiltins: true,
    catalog: false,
    providers: [{ id: "mine", dialect: "openai-chat", baseUrl: "http://mine" }],
    warnings: ['f: unknown setting "colour" (ignored)'],
  })
  expect(session.startupEvents.map((e) => [e.type, e.data])).toEqual([
    ["extension.error", { source: "settings", error: 'f: unknown setting "colour" (ignored)' }],
  ])
})

test("an unknown provider with a preset suggests adding it", async () => {
  const create = (model: string) =>
    createSession({ model, cwd, extensions: [], noBuiltins: true, catalog: false })
  const err = await create("deepseek/deepseek-chat").catch((e) => e)
  expect(err).toBeInstanceOf(UsageError)
  expect(err.message).toContain('unknown provider "deepseek" (known: anthropic, openai, openai-chat, google)')
  expect(err.message).toContain("amira provider add deepseek")
  expect((await create("zzz/m").catch((e) => e)).message).toContain("amira provider presets")
})

test("provider presets prints settings.json entries", () => {
  const io = capture()
  expect(runProviderCommand(["presets"], io, home)).toBe(0)
  const all = JSON.parse(io.out)
  expect(Object.keys(all.providers)).toEqual([
    "deepseek",
    "deepseek-anthropic",
    "openrouter",
    "ollama",
    "lmstudio",
  ])
  expect(all.providers.deepseek).toEqual({
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  })
  expect(all.providers["deepseek-anthropic"].compat).toEqual({ thinking: "budget" })
  const one = capture()
  runProviderCommand(["presets", "ollama"], one, home)
  expect(JSON.parse(one.out)).toEqual({
    providers: { ollama: { dialect: "openai-chat", baseUrl: "http://localhost:11434/v1" } },
  })
  expect(() => runProviderCommand(["presets", "nope"], capture(), home)).toThrow(/no preset "nope"/)
})

test("provider add merges into the user settings and never replaces an entry", () => {
  const file = path.join(home, "settings.json")
  put(file, {
    model: "deepseek/deepseek-chat",
    providers: { ollama: { dialect: "openai-chat", baseUrl: "http://gpu:11434/v1" } },
  })
  const io = capture()
  expect(runProviderCommand(["add", "deepseek"], io, home)).toBe(0)
  expect(io.out).toContain('Added provider "deepseek"')
  expect(io.out).toContain("DEEPSEEK_API_KEY")
  expect(runProviderCommand(["add", "ollama"], io, home)).toBe(0)
  expect(io.out).toContain('"ollama" is already in')
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    model: "deepseek/deepseek-chat",
    providers: {
      ollama: { dialect: "openai-chat", baseUrl: "http://gpu:11434/v1" },
      deepseek: {
        dialect: "openai-chat",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
    },
  })
  expect(() => runProviderCommand(["add"], capture(), home)).toThrow(UsageError)
  expect(() => runProviderCommand([], capture(), home)).toThrow(/missing provider command/)
})
