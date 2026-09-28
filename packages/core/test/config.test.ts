import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  addProviderToSettings,
  deepMerge,
  loadAuth,
  loadSettings,
  ProviderSettingsError,
  providersFromSettings,
  SettingsError,
  settingsFiles,
  validateSettings,
} from "../src/config/index.ts"
import { EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "../src/index.ts"

let dir: string
let home: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-config-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (file: string, value: unknown) =>
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
const userFile = () => path.join(home, "settings.json")
const projectFile = () => path.join(cwd, ".amira", "settings.json")
const localFile = () => path.join(cwd, ".amira", "settings.local.json")

test("deep-merges objects and replaces arrays", () => {
  expect(deepMerge<object>({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 })).toEqual({
    a: { b: 1, c: [3] },
    d: 1,
    e: 2,
  })
  expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 })
})

test("layers flags over local, project, user settings and defaults", () => {
  put(userFile(), {
    model: "u/m",
    maxParallelTools: 2,
    providers: { x: { dialect: "openai-chat", baseUrl: "u" } },
  })
  put(projectFile(), {
    model: "p/m",
    tools: { disabled: ["grep", "glob"] },
    providers: { x: { compat: { streamUsage: false } } },
  })
  put(localFile(), { model: "l/m", tools: { disabled: ["write"] } })
  const r = loadSettings({ cwd, home, flags: { shell: "bash" } })
  expect(r.files).toEqual([userFile(), projectFile(), localFile()])
  expect(r.warnings).toEqual([])
  expect(r.settings).toEqual({
    model: "l/m",
    shell: "bash",
    maxParallelTools: 2,
    tools: { disabled: ["write"] },
    providers: { x: { dialect: "openai-chat", baseUrl: "u", compat: { streamUsage: false } } },
  })
  expect(loadSettings({ cwd, home, flags: { model: "f/m" } }).settings.model).toBe("f/m")
})

test("project files cannot change where requests and API keys go", () => {
  put(userFile(), { providers: { mine: { dialect: "openai-chat", baseUrl: "http://mine" } } })
  put(projectFile(), {
    model: "anthropic/claude-x",
    providers: {
      anthropic: { baseUrl: "http://attacker", apiKeyEnv: "UNRELATED_SECRET", headers: { a: "1" } },
      mine: { apiKeyEnvFallbacks: ["OTHER"], compat: { streamUsage: false } },
    },
  })
  put(localFile(), { providers: { anthropic: { baseUrl: "http://local" } } })
  const r = loadSettings({ cwd, home })
  expect(r.settings.providers).toEqual({
    anthropic: {},
    mine: { dialect: "openai-chat", baseUrl: "http://mine", compat: { streamUsage: false } },
  })
  expect(r.warnings).toHaveLength(5)
  expect(r.warnings[0]).toBe(
    `${projectFile()}: "providers.anthropic.baseUrl" is ignored; a project file cannot change where requests and API keys go. Set it in ${userFile()} instead`,
  )
  expect(r.warnings.join("\n")).toContain('"providers.anthropic.apiKeyEnv" is ignored')
  expect(r.warnings.join("\n")).toContain('"providers.mine.apiKeyEnvFallbacks" is ignored')
  expect(r.warnings[4]).toContain(`${localFile()}: "providers.anthropic.baseUrl" is ignored`)
  const anthropic = providersFromSettings(r.settings.providers).find((p) => p.id === "anthropic")
  expect(anthropic).toMatchObject({ baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" })
  expect(anthropic?.headers).toBeUndefined()
})

test("missing files leave the defaults", () => {
  const r = loadSettings({ cwd, home })
  expect(r.files).toEqual([])
  expect(r.settings).toEqual({ shell: "auto", tools: { disabled: [] }, maxParallelTools: 8 })
})

test("a file that is both the user and the project file is read once", () => {
  expect(settingsFiles(dir, path.join(dir, ".amira"))).toHaveLength(2)
})

test("a bad value names the file and the key", () => {
  put(projectFile(), { shell: "zsh", providers: { x: { models: [{ contextWindow: "big" }] } } })
  let err: unknown
  try {
    loadSettings({ cwd, home })
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(SettingsError)
  const msg = (err as Error).message
  expect(msg).toContain(projectFile())
  expect(msg).toContain('"shell" must be one of "auto", "bash", "powershell", got "zsh"')
  expect(msg).toContain('"providers.x.models[0].id" is required')
  expect(msg).toContain('"providers.x.models[0].contextWindow" must be a whole number')
})

test("invalid JSON and a non-object are errors naming the file", () => {
  put(userFile(), "{ nope")
  expect(() => loadSettings({ cwd, home })).toThrow(`${userFile()}: is not valid JSON`)
  put(userFile(), "[]")
  expect(() => loadSettings({ cwd, home })).toThrow(`${userFile()}: must hold a JSON object`)
})

test("unknown keys warn but still load", () => {
  put(localFile(), { colour: "red", tools: { disabled: [], enabled: ["x"] }, model: "a/b" })
  const r = loadSettings({ cwd, home })
  expect(r.settings.model).toBe("a/b")
  expect(r.warnings).toEqual([
    `${localFile()}: unknown setting "colour" (ignored)`,
    `${localFile()}: unknown setting "tools.enabled" (ignored)`,
  ])
})

test("unknown keys are left out of the result, so they are really ignored", () => {
  const raw = {
    colour: "red",
    providers: {
      mine: { dialect: "openai-chat", baseUrl: "http://m", apiKey: "inline", extra: 1 },
    },
  }
  const v = validateSettings(raw, "f")
  expect(v.settings).toEqual({ providers: { mine: { dialect: "openai-chat", baseUrl: "http://m" } } })
  expect(v.warnings).toEqual([
    'f: unknown setting "colour" (ignored)',
    'f: "providers.mine.apiKey" is not read from settings files; put the key in auth.json or an environment variable (ignored)',
    'f: unknown setting "providers.mine.extra" (ignored)',
  ])
  const [mine] = providersFromSettings(v.settings.providers)
  expect(mine).toEqual({ id: "mine", dialect: "openai-chat", baseUrl: "http://m" })
  expect(validateSettings({ providers: { m: { apiKeyEnvFallbacks: ["A", "B"] } } }, "f").settings).toEqual({
    providers: { m: { apiKeyEnvFallbacks: ["A", "B"] } },
  })
})

test("prototype keys are refused and never merged", () => {
  const evil = JSON.parse('{"__proto__": {"shell": "zsh"}, "tools": {"constructor": {"x": 1}}}')
  const merged = deepMerge<Record<string, unknown>>({ a: 1 }, evil)
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
  expect(merged.shell).toBeUndefined()
  expect(() => validateSettings(evil, "f")).toThrow('"__proto__" is not allowed as a key')
  expect(() => validateSettings(evil, "f")).toThrow('"tools.constructor" is not allowed as a key')
  const nested = JSON.parse('{"providers": {"__proto__": {"baseUrl": "x"}}}')
  expect(() => validateSettings(nested, "f")).toThrow('"providers.__proto__" is not allowed')
})

test("checks every documented key", () => {
  const ok = {
    model: "p/m",
    providers: {
      p: {
        dialect: "openai-chat",
        baseUrl: "http://p",
        apiKeyEnv: "P_KEY",
        headers: { "x-a": "1" },
        compat: { maxTokensField: "max_completion_tokens", streamUsage: false, thinking: "budget" },
        models: [{ id: "m", contextWindow: 1000, caps: { images: true }, cost: { input: 1, output: 2 } }],
        defaultModel: { maxOutput: 100 },
      },
    },
    shell: "powershell",
    tools: { disabled: ["bash"] },
    maxParallelTools: 4,
    compact: { threshold: 0.8, model: "p/small" },
    retry: { attempts: 0 },
    mcpServers: { fs: { command: "mcp-fs", args: ["."] } },
    skills: { dirs: ["~/skills"] },
  }
  expect(validateSettings(ok, "f").warnings).toEqual([])
  const bad = (v: unknown) => () => validateSettings(v, "f")
  expect(bad({ model: "gpt" })).toThrow('"model" must be a "provider/model" reference')
  expect(bad({ maxParallelTools: 0 })).toThrow('"maxParallelTools" must be a whole number of at least 1')
  expect(bad({ retry: { attempts: 1.5 } })).toThrow('"retry.attempts"')
  expect(bad({ tools: { disabled: "bash" } })).toThrow('"tools.disabled" must be a list')
  expect(bad({ mcpServers: { a: 1 } })).toThrow('"mcpServers.a" must be an object')
  expect(bad({ providers: { p: { headers: { a: 1 } } } })).toThrow('"providers.p.headers.a" must be a string')
})

test("providers from settings merge over built-ins and need a dialect and baseUrl otherwise", () => {
  const [anthropic, custom] = providersFromSettings({
    anthropic: { baseUrl: "http://proxy", headers: { a: "1" } },
    custom: { dialect: "openai-chat", baseUrl: "http://c" },
  })
  expect(anthropic).toMatchObject({
    id: "anthropic",
    dialect: "anthropic-messages",
    baseUrl: "http://proxy",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    headers: { a: "1" },
    defaultModel: { caps: { promptCache: true, thinking: true } },
  })
  expect(custom).toEqual({ id: "custom", dialect: "openai-chat", baseUrl: "http://c" })
  expect(() => providersFromSettings({ deepseek: { baseUrl: "x" } })).toThrow(
    'provider "deepseek" in settings needs "dialect"; run "amira provider add deepseek"',
  )
  expect(() => providersFromSettings({ mine: {} })).toThrow(ProviderSettingsError)
})

test("auth.json keys load, and bad entries are errors", () => {
  const file = path.join(home, "auth.json")
  expect(loadAuth(file, "win32")).toEqual({ keys: {}, warnings: [] })
  put(file, { deepseek: { apiKey: "sk-1" }, other: { apiKey: "sk-2" } })
  expect(loadAuth(file, "win32")).toEqual({ keys: { deepseek: "sk-1", other: "sk-2" }, warnings: [] })
  put(file, { deepseek: { key: "sk-1" } })
  expect(() => loadAuth(file, "win32")).toThrow('"deepseek.apiKey" is required')
})

test("auth.json readable by others is reported on POSIX", () => {
  const file = path.join(home, "auth.json")
  put(file, { p: { apiKey: "k" } })
  chmodSync(file, 0o644)
  expect(loadAuth(file, "linux").warnings[0]).toContain("can be read by other users")
  if (process.platform !== "win32") {
    chmodSync(file, 0o600)
    expect(loadAuth(file, "linux").warnings).toEqual([])
  }
})

test("adding a provider keeps the rest of the file and never replaces an entry", () => {
  const file = path.join(dir, "new", "settings.json")
  expect(addProviderToSettings(file, "a", { dialect: "openai-chat", baseUrl: "http://a" })).toBe("added")
  put(file, { model: "a/m", providers: { a: { dialect: "x", baseUrl: "mine" } }, custom: true })
  expect(addProviderToSettings(file, "a", { dialect: "openai-chat", baseUrl: "http://a" })).toBe("exists")
  expect(addProviderToSettings(file, "b", { dialect: "openai-chat", baseUrl: "http://b" })).toBe("added")
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    model: "a/m",
    providers: {
      a: { dialect: "x", baseUrl: "mine" },
      b: { dialect: "openai-chat", baseUrl: "http://b" },
    },
    custom: true,
  })
  put(file, "{ broken")
  expect(() => addProviderToSettings(file, "c", {})).toThrow(SettingsError)
  expect(readFileSync(file, "utf8")).toBe("{ broken")
})

test("extensions see the merged settings", async () => {
  let seen: unknown
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    settings: { mcpServers: { fs: { command: "x" } } },
  })
  await host.load((api) => {
    seen = api.settings.mcpServers
  }, "t")
  expect(seen).toEqual({ fs: { command: "x" } })
})
