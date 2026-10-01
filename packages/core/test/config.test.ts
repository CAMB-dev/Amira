import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
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

test("server-side compaction and its layout are settings; a project file cannot turn it on", () => {
  put(userFile(), {
    providers: {
      proxy: {
        dialect: "openai-responses",
        baseUrl: "http://localhost:8317/v1",
        compat: { compaction: "on" },
      },
    },
    compact: { layout: "recent-user" },
  })
  put(projectFile(), { providers: { other: { compat: { compaction: "on", streamUsage: false } } } })
  const r = loadSettings({ cwd, home })
  expect(r.settings.providers?.proxy?.compat).toEqual({ compaction: "on" })
  expect(r.settings.providers?.other?.compat).toEqual({ streamUsage: false })
  expect(r.settings.compact).toEqual({ layout: "recent-user" })
  expect(r.warnings).toEqual([
    `${projectFile()}: "providers.other.compat.compaction" is ignored; server-side compaction is only turned on or off in ${userFile()}`,
  ])
  put(userFile(), { providers: { p: { compat: { compaction: "sometimes" } } } })
  expect(() => loadSettings({ cwd, home })).toThrow(/compaction/)
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
  expect(anthropic).toEqual({
    id: "anthropic",
    dialect: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  })
})

test("project files cannot choose web backends' endpoints or open the private network", () => {
  put(userFile(), { web: { search: { searxng: { url: "http://localhost:8888" } } } })
  put(projectFile(), {
    web: {
      search: {
        backend: "searxng",
        exa: { url: "http://attacker", apiKeyEnv: "SECRET" },
        brave: { apiKeyEnv: "SECRET" },
        tavily: { apiKeyEnv: "SECRET", searchDepth: "advanced" },
        searxng: { url: "http://attacker" },
      },
      fetch: { allowPrivateNetwork: true, maxChars: 100 },
    },
  })
  const r = loadSettings({ cwd, home })
  expect(r.settings.web).toEqual({
    search: {
      backend: "searxng",
      exa: {},
      brave: {},
      tavily: { searchDepth: "advanced" },
      searxng: { url: "http://localhost:8888" },
    },
    fetch: { maxChars: 100 },
  })
  expect(r.warnings).toHaveLength(6)
  expect(r.warnings.join("\n")).toContain('"web.fetch.allowPrivateNetwork" is ignored')
})

test("only the user file says which packages load and which projects are trusted", () => {
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ packages: { trustedProjects: ["/mine"], disabled: ["a"] } }),
  )
  // A project file could otherwise turn the user's disabled package back on (lists replace).
  writeFileSync(
    path.join(cwd, ".amira", "settings.json"),
    JSON.stringify({ packages: { trustedProjects: [cwd], untrustedProjects: [], disabled: [] } }),
  )
  const r = loadSettings({ cwd, home })
  expect(r.settings.packages).toEqual({ trustedProjects: ["/mine"], disabled: ["a"] })
  expect(r.warnings).toHaveLength(3)
  expect(r.warnings[0]).toContain(
    '"packages.disabled" is ignored; a project file cannot choose which packages load',
  )
  expect(r.warnings[1]).toContain('"packages.trustedProjects" is ignored')
})

test("web settings are checked", () => {
  expect(() => validateSettings({ web: { search: { backend: "bing" } } }, "f")).toThrow(
    '"web.search.backend" must be one of',
  )
  expect(() => validateSettings({ web: { fetch: { maxChars: 0 } } }, "f")).toThrow("web.fetch.maxChars")
})

test("hosted web search settings: per provider and model, and a switch for all", () => {
  const ok = {
    web: { nativeSearch: false },
    providers: {
      p: {
        dialect: "openai-responses",
        baseUrl: "http://localhost:8317/v1",
        compat: { webSearch: true },
        models: [{ id: "m", caps: { webSearch: false } }],
      },
    },
  }
  const r = validateSettings(ok, "f")
  expect(r.settings).toEqual(ok)
  expect(r.warnings).toEqual([])
  expect(() => validateSettings({ web: { nativeSearch: "yes" } }, "f")).toThrow("web.nativeSearch")
  expect(() => validateSettings({ providers: { p: { compat: { webSearch: "on" } } } }, "f")).toThrow(
    "providers.p.compat.webSearch",
  )
})

test("command aliases are checked: alias names like command names, values command lines", () => {
  const ok = { commandAliases: { ds: "model deepseek/deepseek-flash", "?": "help", m: " model " } }
  expect(validateSettings(ok, "f").settings).toEqual(ok)
  expect(() => validateSettings({ commandAliases: { ds: "/model x" } }, "f")).toThrow(
    '"commandAliases.ds" must be a command line without the slash',
  )
  expect(() => validateSettings({ commandAliases: { ds: 3 } }, "f")).toThrow('"commandAliases.ds" must be')
  expect(() => validateSettings({ commandAliases: { "my alias": "model" } }, "f")).toThrow(
    '"commandAliases.my alias" is not a valid alias name',
  )
  expect(() => validateSettings({ commandAliases: ["model"] }, "f")).toThrow(
    '"commandAliases" must be an object',
  )
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
        catalogId: false,
        compat: { maxTokensField: "max_completion_tokens", streamUsage: false, thinking: "budget" },
        models: [{ id: "m", contextWindow: 1000, caps: { images: true }, cost: { input: 1, output: 2 } }],
        defaultModel: { maxOutput: 100 },
      },
    },
    shell: "powershell",
    tools: { disabled: ["bash"] },
    maxParallelTools: 4,
    compact: { threshold: 0.8, model: "p/small" },
    retry: { attempts: 0, baseDelayMs: 500, maxDelayMs: 30_000 },
    mcpServers: { fs: { command: "mcp-fs", args: ["."] } },
    extensions: {
      swarm: { confirm: false, limits: { maxMessages: 50 } },
      workflow: { enabled: "always", maxAgents: 12, budget: { tokens: 500000 } },
    },
    skills: { dirs: ["~/skills"] },
  }
  expect(validateSettings(ok, "f").warnings).toEqual([])
  expect(validateSettings(ok, "f").settings.extensions).toEqual(ok.extensions)
  const bad = (v: unknown) => () => validateSettings(v, "f")
  expect(bad({ model: "gpt" })).toThrow('"model" must be a "provider/model" reference')
  expect(bad({ maxParallelTools: 0 })).toThrow('"maxParallelTools" must be a whole number of at least 1')
  expect(bad({ retry: { attempts: 1.5 } })).toThrow('"retry.attempts"')
  expect(bad({ retry: { baseDelayMs: -1 } })).toThrow('"retry.baseDelayMs"')
  expect(bad({ providers: { p: { catalogId: true } } })).toThrow(
    '"providers.p.catalogId" must be a string or false',
  )
  expect(bad({ tools: { disabled: "bash" } })).toThrow('"tools.disabled" must be a list')
  expect(bad({ mcpServers: { a: 1 } })).toThrow('"mcpServers.a" must be an object')
  expect(bad({ extensions: { swarm: true } })).toThrow('"extensions.swarm" must be an object')
  expect(bad({ providers: { p: { headers: { a: 1 } } } })).toThrow('"providers.p.headers.a" must be a string')
  expect(bad({ providers: { p: { models: [{ id: "m", cost: { input: 1 } }] } } })).toThrow(
    '"providers.p.models[0].cost.output" is required',
  )
})

test("providers come only from settings, and each needs a dialect and baseUrl", () => {
  expect(providersFromSettings()).toEqual([])
  expect(providersFromSettings({})).toEqual([])
  const [custom] = providersFromSettings({ custom: { dialect: "openai-chat", baseUrl: "http://c" } })
  expect(custom).toEqual({ id: "custom", dialect: "openai-chat", baseUrl: "http://c" })
  expect(() => providersFromSettings({ deepseek: { baseUrl: "x" } })).toThrow(
    'provider "deepseek" in settings.json needs "dialect"; fix the entry, or remove it and run "amira provider add"',
  )
  expect(() => providersFromSettings({ mine: {} })).toThrow('needs "dialect" and "baseUrl"')
  expect(() => providersFromSettings({ mine: {} })).toThrow(ProviderSettingsError)
  // Inherited object keys are not provider ids.
  expect(() => providersFromSettings({ toString: {} })).toThrow(ProviderSettingsError)
})

test("an old entry for a formerly built-in provider keeps its dialect and baseUrl", () => {
  const warnings: string[] = []
  const [anthropic, openai, google] = providersFromSettings(
    {
      anthropic: { headers: { a: "1" }, models: [{ id: "claude-x" }] },
      openai: { baseUrl: "http://proxy" },
      google: { apiKeyEnv: "MY_GEMINI_KEY" },
    },
    warnings,
  )
  expect(warnings).toHaveLength(3)
  expect(warnings[0]).toBe(
    'provider "anthropic" in settings.json lacks "dialect" or "baseUrl", so the former built-in ones ' +
      '(anthropic-messages, https://api.anthropic.com) are used; it has no "apiKeyEnv" any more. ' +
      'Complete it with "amira provider edit anthropic"',
  )
  expect(warnings[2]).not.toContain("apiKeyEnv")
  // Only the dialect and baseUrl come back; no key variable or other defaults.
  expect(anthropic).toEqual({
    id: "anthropic",
    dialect: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    headers: { a: "1" },
    models: [{ id: "claude-x" }],
  })
  expect(openai).toEqual({ id: "openai", dialect: "openai-responses", baseUrl: "http://proxy" })
  expect(google).toMatchObject({ dialect: "google-gemini", apiKeyEnv: "MY_GEMINI_KEY" })
  // A full entry is taken as it is.
  const [own] = providersFromSettings({ anthropic: { dialect: "openai-chat", baseUrl: "http://own" } })
  expect(own).toEqual({ id: "anthropic", dialect: "openai-chat", baseUrl: "http://own" })
})

test("fully defined entries such as deepseek and deepseek-anthropic load unchanged", () => {
  const entries = {
    deepseek: {
      dialect: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      catalogId: "deepseek",
      models: [{ id: "deepseek-flash" }],
    },
    "deepseek-anthropic": {
      dialect: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      catalogId: "deepseek",
      compat: { thinking: "budget" as const },
      defaultModel: { caps: { thinking: true, promptCache: true } },
    },
  }
  expect(providersFromSettings(entries)).toEqual([
    { id: "deepseek", ...entries.deepseek },
    { id: "deepseek-anthropic", ...entries["deepseek-anthropic"] },
  ])
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

test("adding a provider refuses to run beside another writer and always releases its lock", () => {
  const file = path.join(home, "settings.json")
  put(`${file}.lock`, "")
  expect(() => addProviderToSettings(file, "a", { dialect: "openai-chat" })).toThrow(
    "is being changed by another amira process",
  )
  rmSync(`${file}.lock`)
  mkdirSync(file)
  expect(() => addProviderToSettings(file, "a", { dialect: "openai-chat" })).toThrow(SettingsError)
  expect(readdirSync(home).sort()).toEqual(["settings.json"])
})

test("adding a provider takes over a lock left behind by a process that died", () => {
  const file = path.join(home, "settings.json")
  put(`${file}.lock`, "")
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${file}.lock`, old, old)
  expect(addProviderToSettings(file, "a", { dialect: "openai-chat" })).toBe("added")
  expect(readdirSync(home).sort()).toEqual(["settings.json"])
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

test("an extension cannot change the settings another extension reads", async () => {
  const settings = { tools: { disabled: ["bash"] } }
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    settings,
  })
  await host.load((api) => {
    const disabled = api.settings.tools?.disabled as string[]
    disabled.push("grep")
  }, "a")
  let seen: unknown
  await host.load((api) => {
    seen = api.settings.tools?.disabled
  }, "b")
  expect(seen).toEqual(["bash"])
  expect(settings.tools.disabled).toEqual(["bash"])
})

test("sub-agent settings: role models, limits, budget and the merge review threshold", () => {
  const raw = {
    agents: { explorer: { model: "cheap/small" } },
    subagents: { maxDepth: 1, maxConcurrent: 2 },
    budget: { tokens: 100_000, costUsd: 0.5 },
    merge: { reviewThreshold: { lines: 200, files: 5 } },
  }
  expect(validateSettings(raw, "f")).toEqual({ settings: raw, warnings: [] })
  expect(() => validateSettings({ agents: { coder: { model: "nope" } } }, "f")).toThrow(
    '"agents.coder.model"',
  )
  expect(() => validateSettings({ subagents: { maxConcurrent: 0 } }, "f")).toThrow(
    '"subagents.maxConcurrent"',
  )
  expect(() => validateSettings({ budget: { costUsd: "1" } }, "f")).toThrow('"budget.costUsd"')
})

test("background job settings: how many run at once, and how much output is kept", () => {
  const raw = { backgroundJobs: { maxRunning: 3, bufferChars: 200_000, maxLogBytes: 0 } }
  expect(validateSettings(raw, "f")).toEqual({ settings: raw, warnings: [] })
  expect(() => validateSettings({ backgroundJobs: { maxRunning: 0 } }, "f")).toThrow(
    '"backgroundJobs.maxRunning"',
  )
  expect(() => validateSettings({ backgroundJobs: { bufferChars: 10 } }, "f")).toThrow(
    '"backgroundJobs.bufferChars"',
  )
})

test("tui settings: bell, title, progress, reflow and submitWhileWorking", () => {
  const raw = {
    tui: {
      bell: false,
      title: true,
      progress: false,
      reflow: "off" as const,
      submitWhileWorking: "queue" as const,
    },
  }
  expect(validateSettings(raw, "f")).toEqual({ settings: raw, warnings: [] })
  expect(() => validateSettings({ tui: { reflow: "maybe" } }, "f")).toThrow('"tui.reflow"')
  expect(() => validateSettings({ tui: { submitWhileWorking: "send" } }, "f")).toThrow(
    '"tui.submitWhileWorking"',
  )
  expect(() => validateSettings({ tui: { bell: "no" } }, "f")).toThrow('"tui.bell"')
  // The user file sets it, a project overrides it.
  put(userFile(), { tui: { submitWhileWorking: "queue", bell: false } })
  expect(loadSettings({ cwd, home }).settings.tui).toEqual({ submitWhileWorking: "queue", bell: false })
  put(projectFile(), { tui: { submitWhileWorking: "steer" } })
  expect(loadSettings({ cwd, home }).settings.tui).toEqual({ submitWhileWorking: "steer", bell: false })
  expect(validateSettings({ tui: { blink: true } }, "f").warnings).toEqual([
    'f: unknown setting "tui.blink" (ignored)',
  ])
})

test("tui.mode is fullscreen or inline", () => {
  for (const mode of ["fullscreen", "inline"] as const) {
    expect(validateSettings({ tui: { mode } }, "f")).toEqual({ settings: { tui: { mode } }, warnings: [] })
  }
  expect(() => validateSettings({ tui: { mode: "split" } }, "f")).toThrow('"tui.mode"')
})
