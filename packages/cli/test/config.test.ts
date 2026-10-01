import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionStore } from "@amira/core"
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
const userSettingsFile = () => path.join(home, "settings.json")
const projectSettingsFile = () => path.join(cwd, ".amira", "settings.json")
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
  // The shell mode hides tools by their declared shell once they are registered (toolsToDisable).
  expect(config([])).toMatchObject({ shell: "bash", disabledTools: ["glob"] })
  expect(config(["--shell", "powershell"]).shell).toBe(process.platform === "win32" ? "powershell" : "auto")
  expect(config(["--disable-tools", "grep"])).toMatchObject({ shell: "bash", disabledTools: ["grep"] })
  expect(config(["--shell", "auto", "--disable-tools", ""])).toMatchObject({
    shell: "auto",
    disabledTools: [],
  })
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

test("session reload hands extensions fresh settings and provenance", async () => {
  const seen: { model: string | undefined; layers: unknown }[] = []
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
          seen.push({ model: api.settings.model, layers: api.settings.layers("model") })
        },
      },
    ],
    settings: { model: "first" },
    settingsLayers: { model: [{ scope: "user", file: userSettingsFile(), value: "first" }] },
    reloadSettings: () => ({
      settings: { model: "second" },
      layers: { model: [{ scope: "project", file: projectSettingsFile(), value: "second" }] },
      warnings: ["reloaded warning"],
    }),
    providers: [{ id: "mine", dialect: "openai-chat", baseUrl: "http://mine" }],
  })
  expect(seen).toEqual([
    { model: "first", layers: [{ scope: "user", file: userSettingsFile(), value: "first" }] },
  ])
  const errors: unknown[] = []
  session.agent.bus.subscribe((e) => void errors.push(e.data), { types: ["extension.error"] })
  await session.reload()
  await session.agent.bus.flush()
  expect(errors).toContainEqual({ source: "settings", error: "reloaded warning" })
  expect(seen).toEqual([
    { model: "first", layers: [{ scope: "user", file: userSettingsFile(), value: "first" }] },
    { model: "second", layers: [{ scope: "project", file: projectSettingsFile(), value: "second" }] },
  ])
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
      `unknown provider "${ref.split("/")[0]}" (no providers are configured); add it with amira provider add, or pick another with --model`,
    )
  }
  const err = await create("zzz/m", [{ id: "mine", dialect: "openai-chat", baseUrl: "http://mine" }]).catch(
    (e) => e,
  )
  expect(err.message).toBe(
    'unknown provider "zzz" (configured: mine); add it with amira provider add, or pick another with --model',
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

test("a resumed session without a model given continues on the one it ran on", async () => {
  const providers = [
    { id: "a", dialect: "openai-chat", baseUrl: "http://a", models: [{ id: "m" }] },
    { id: "b", dialect: "openai-chat", baseUrl: "http://b" },
  ]
  const store = SessionStore.create({ cwd, dir: path.join(dir, "sessions") })
  store.append({ type: "model_change", model: { provider: "b", model: "big" } })
  const create = (s: SessionStore) =>
    createSession({ cwd, extensions: [], noBuiltins: true, catalog: false, providers, store: s })
  const resumed = await create(store)
  expect(`${resumed.agent.model.provider}/${resumed.agent.model.id}`).toBe("b/big")
  expect(resumed.modelNotice).toBeUndefined()
  // A new session has no model to go on; switching to the stored one picks its model up.
  const fresh = await create(SessionStore.create({ cwd, dir: path.join(dir, "sessions") }))
  expect(fresh.agent.model.provider).toBe("")
  expect(fresh.resume(store).model.id).toBe("big")
})

test("an old entry for a former built-in id works with a warning that it lost its key variable", () => {
  put(path.join(home, "settings.json"), { providers: { anthropic: { models: [{ id: "claude-x" }] } } })
  const c = config([])
  expect(c.providers).toEqual([
    {
      id: "anthropic",
      dialect: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "claude-x" }],
    },
  ])
  expect(c.warnings.join("\n")).toContain(
    'it has no "apiKeyEnv" any more. Complete it with "amira provider edit anthropic"',
  )
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

test("permissions: --permission-mode wins, a project only tightens, untrusted project allows are dropped", () => {
  expect(config([]).permissions).toMatchObject({ mode: "auto", modeSource: "default", rules: [] })
  put(path.join(home, "settings.json"), {
    permissions: { mode: "edits", rules: [{ command: ["git", "push"], decision: "ask" }] },
  })
  put(path.join(cwd, ".amira", "settings.json"), {
    permissions: {
      mode: "auto",
      rules: [
        { command: ["git", "push"], decision: "allow" },
        { command: ["rm"], decision: "deny" },
      ],
    },
  })
  const c = config([])
  expect(c.permissions.mode).toBe("edits")
  expect(c.permissions.rules.map((r) => `${r.command.join(" ")} ${r.decision} ${r.source.scope}`)).toEqual([
    "git push ask user",
    "rm deny project",
  ])
  expect(c.warnings.join("\n")).toContain('"permissions.mode" "auto" is ignored')
  expect(c.warnings.join("\n")).toContain("this project is not trusted")
  // Merged settings carry no permissions: only the resolved ones count.
  expect(c.settings.permissions).toBeUndefined()
  // Trusted (as for its packages), the project's allow rule joins; it still cannot beat the user's ask.
  put(path.join(home, "settings.json"), {
    permissions: { mode: "edits", rules: [{ command: ["git", "push"], decision: "ask" }] },
    packages: { trustedProjects: [cwd] },
  })
  expect(config([]).permissions.rules).toHaveLength(3)
  put(path.join(cwd, ".amira", "settings.local.json"), { permissions: { mode: "plan" } })
  expect(config([]).permissions.mode).toBe("plan")
  expect(config(["--permission-mode", "auto"]).permissions).toMatchObject({
    mode: "auto",
    modeSource: "--permission-mode",
  })
  expect(() => config(["--permission-mode", "yolo"])).toThrow(UsageError)
})
