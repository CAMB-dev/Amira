import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

test("an unknown provider names the configured ones and says how to add one", async () => {
  const create = (model: string, providers: { id: string; dialect: string; baseUrl: string }[] = []) =>
    createSession({ model, cwd, extensions: [], noBuiltins: true, catalog: false, providers })
  for (const ref of ["anthropic/claude-x", "openai/gpt-5", "google/gemini-x", "openai-chat/gpt-5"]) {
    const err = await create(ref).catch((e) => e)
    expect(err).toBeInstanceOf(UsageError)
    expect(err.message).toBe(
      `unknown provider "${ref.split("/")[0]}" (no providers are configured); add it with /provider add (or amira provider add)`,
    )
  }
  const err = await create("zzz/m", [{ id: "mine", dialect: "openai-chat", baseUrl: "http://mine" }]).catch(
    (e) => e,
  )
  expect(err.message).toBe(
    'unknown provider "zzz" (configured: mine); add it with /provider add (or amira provider add)',
  )
})

test("without a model the only provider's first model is used, else none until one is picked", async () => {
  const create = (providers: { id: string; dialect: string; baseUrl: string; models?: { id: string }[] }[]) =>
    createSession({ cwd, extensions: [], noBuiltins: true, catalog: false, providers })
  const none = await create([])
  expect(none.agent.model.provider).toBe("")
  expect(none.modelNotice).toBe(
    "No providers configured — add one with /provider add, then pick a model with /model.",
  )
  const only = await create([
    { id: "ds", dialect: "openai-chat", baseUrl: "http://ds", models: [{ id: "flash" }, { id: "pro" }] },
  ])
  expect(`${only.agent.model.provider}/${only.agent.model.id}`).toBe("ds/flash")
  expect(only.modelNotice).toBeUndefined()
  const unlisted = await create([{ id: "ds", dialect: "openai-chat", baseUrl: "http://ds" }])
  expect(unlisted.modelNotice).toBe(
    'No model selected — pick one with /model, or set "model" in settings.json.',
  )
  const two = await create([
    { id: "a", dialect: "openai-chat", baseUrl: "http://a", models: [{ id: "m" }] },
    { id: "b", dialect: "openai-chat", baseUrl: "http://b", models: [{ id: "m" }] },
  ])
  expect(two.agent.model.provider).toBe("")
  expect(two.modelNotice).toContain("No model selected")
})

test("print mode needs a model: without one it is a usage error", async () => {
  const create = (providers: { id: string; dialect: string; baseUrl: string }[]) =>
    createSession({ cwd, extensions: [], noBuiltins: true, catalog: false, providers, requireModel: true })
  const none = await create([]).catch((e) => e)
  expect(none).toBeInstanceOf(UsageError)
  expect(none.message).toBe(
    'no providers configured; add one with "amira provider add", then pass --model provider/model',
  )
  const unpicked = await create([{ id: "a", dialect: "openai-chat", baseUrl: "http://a" }]).catch((e) => e)
  expect(unpicked).toBeInstanceOf(UsageError)
  expect(unpicked.message).toContain("no model selected. Pass --model provider/model")
})

test("amira provider help lists the commands; presets are gone", () => {
  const io = capture()
  expect(runProviderCommand(["help"], io)).toBe(0)
  expect(io.out).toContain("amira provider add [<protocol>]")
  expect(io.out).toContain("Amira has no built-in providers")
  expect(io.out).not.toContain("preset")
  expect(() => runProviderCommand(["presets"], capture())).toThrow('unknown provider command "presets"')
  expect(() => runProviderCommand([], capture())).toThrow(/missing provider command/)
})

test("a provider left incomplete by an ignored project key says why", () => {
  put(path.join(cwd, ".amira", "settings.local.json"), {
    model: "ollama/llama3",
    providers: { ollama: { dialect: "openai-chat", baseUrl: "http://gpu:11434/v1" } },
  })
  let message = ""
  try {
    config([])
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toContain('provider "ollama" in settings.json needs "baseUrl"')
  expect(message).toContain('"providers.ollama.baseUrl" is ignored')
  expect(message).toContain(path.join(home, "settings.json"))
})
