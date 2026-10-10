import type { Settings } from "@amira/api"
import { isCommandAliasName } from "../commands.ts"
import { isPlainObject, UNSAFE_KEYS } from "./merge.ts"

/** A settings file that cannot be used; the message names the file and the key. */
export class SettingsError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(
      problems.length === 1
        ? `${file}: ${problems[0]}`
        : `${file}:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    )
    this.name = "SettingsError"
  }
}

interface Findings {
  errors: string[]
  warnings: string[]
}

/** Checks a value and returns what may be used: unknown keys are left out. */
type Check = (value: unknown, key: string, out: Findings) => unknown

const show = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 40 ? `${s.slice(0, 37)}...` : s
}
const expect = (want: string, ok: (v: unknown) => boolean): Check => {
  return (v, key, out) => {
    if (!ok(v)) out.errors.push(`"${key}" must be ${want}, got ${show(v)}`)
    return v
  }
}

const string = expect("a string", (v) => typeof v === "string")
const boolean = expect("true or false", (v) => typeof v === "boolean")
const number = expect("a number", (v) => typeof v === "number" && Number.isFinite(v))
const integer = (min: number) =>
  expect(`a whole number of at least ${min}`, (v) => Number.isInteger(v) && (v as number) >= min)
const share = expect("a number between 0 and 1", (v) => typeof v === "number" && v > 0 && v < 1)
const oneOf = (...values: string[]) =>
  expect(`one of ${values.map((v) => `"${v}"`).join(", ")}`, (v) => values.includes(v as string))

/** Walks an object's own keys, reporting the ones that could change a prototype. */
function entries(v: Record<string, unknown>, at: (k: string) => string, out: Findings) {
  return Object.entries(v).filter(([k]) => {
    if (UNSAFE_KEYS.has(k)) out.errors.push(`"${at(k)}" is not allowed as a key`)
    return !UNSAFE_KEYS.has(k)
  })
}

const anyObject: Check = (v, key, out) => {
  if (!isPlainObject(v)) return void out.errors.push(`"${key}" must be an object, got ${show(v)}`)
  return Object.fromEntries(entries(v, (k) => `${key}.${k}`, out))
}

function list(item: Check): Check {
  return (v, key, out) => {
    if (!Array.isArray(v)) return void out.errors.push(`"${key}" must be a list, got ${show(v)}`)
    return v.map((x, i) => item(x, `${key}[${i}]`, out))
  }
}

function record(item: Check): Check {
  return (v, key, out) => {
    if (!isPlainObject(v)) return void out.errors.push(`"${key}" must be an object, got ${show(v)}`)
    const at = (k: string) => (key ? `${key}.${k}` : k)
    return Object.fromEntries(entries(v, at, out).map(([k, x]) => [k, item(x, at(k), out)]))
  }
}

/**
 * Known keys are checked; unknown keys only warn, so newer settings files still load, and
 * are left out of the result. `notes` replaces the warning for keys that are known mistakes.
 */
function object(
  shape: Record<string, Check>,
  required: string[] = [],
  notes: Record<string, string> = {},
): Check {
  return (v, key, out) => {
    if (!isPlainObject(v)) return void out.errors.push(`"${key}" must be an object, got ${show(v)}`)
    const at = (k: string) => (key ? `${key}.${k}` : k)
    for (const k of required) if (v[k] === undefined) out.errors.push(`"${at(k)}" is required`)
    const kept: [string, unknown][] = []
    for (const [k, x] of entries(v, at, out)) {
      const check = Object.hasOwn(shape, k) ? shape[k] : undefined
      if (check) kept.push([k, check(x, at(k), out)])
      else
        out.warnings.push(`${notes[k] ? `"${at(k)}" ${notes[k]}` : `unknown setting "${at(k)}"`} (ignored)`)
    }
    return Object.fromEntries(kept)
  }
}

const modelRef = expect(
  'a "provider/model" reference',
  (v) => typeof v === "string" && v.indexOf("/") > 0 && !v.endsWith("/"),
)

const editingTools = object({ edit: oneOf("edit", "apply_patch", "both") })
const thinking = oneOf("low", "medium", "high", "xhigh", "max")

const thinkingDisplay = oneOf("summarized", "omitted")

const modelOverrides = (required: string[], tools = false) =>
  object(
    {
      id: string,
      dialect: string,
      contextWindow: integer(1),
      maxOutput: integer(1),
      compat: object({ thinkingDisplay }),
      ...(tools ? { tools: editingTools, thinking } : {}),
      caps: object({
        tools: oneOf("native", "none"),
        images: boolean,
        thinking: boolean,
        promptCache: boolean,
        parallelToolCalls: boolean,
        webSearch: boolean,
      }),
      cost: object(
        { input: number, output: number, cacheRead: number, cacheWrite: number, webSearch: number },
        ["input", "output"],
      ),
    },
    required,
  )

const provider = object(
  {
    dialect: string,
    baseUrl: string,
    apiKeyEnv: string,
    apiKeyEnvFallbacks: list(string),
    headers: record(string),
    catalogId: expect("a string or false", (v) => typeof v === "string" || v === false),
    compat: object({
      maxTokensField: oneOf("max_tokens", "max_completion_tokens"),
      webSearch: boolean,
      streamUsage: boolean,
      thinking: oneOf("adaptive", "budget"),
      thinkingDisplay,
      compaction: oneOf("auto", "on", "off"),
    }),
    tools: editingTools,
    models: list(modelOverrides(["id"], true)),
    defaultModel: modelOverrides([]),
  },
  [],
  { apiKey: "is not read from settings files; put the key in auth.json or an environment variable" },
)

const webBackend = oneOf("exa", "brave", "tavily", "searxng")

/** `{"ds": "model deepseek/deepseek-flash"}`: alias names to command lines without the slash. */
const commandAliases: Check = (v, key, out) => {
  const kept = record(
    expect('a command line without the slash, e.g. "model deepseek/deepseek-flash"', (x) =>
      typeof x === "string" ? /^[A-Za-z0-9][\w:.-]*(?:\s|$)/.test(x.trim()) : false,
    ),
  )(v, key, out) as Record<string, unknown> | undefined
  for (const name of Object.keys(kept ?? {})) {
    if (!isCommandAliasName(name)) {
      out.errors.push(`"${key}.${name}" is not a valid alias name: use letters, digits and - _ : . or "?"`)
    }
  }
  return kept
}

/** A command rule's words: at least the command name, none of them empty. */
const commandWords = expect(
  'a list of the command\'s words, e.g. ["git", "push"]',
  (v) => Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === "string" && w.trim() !== ""),
)

const permissionMode = oneOf("plan", "edits", "auto")

const permissions = object({
  mode: permissionMode,
  rules: list(
    object({ command: commandWords, decision: oneOf("allow", "ask", "deny"), reason: string }, [
      "command",
      "decision",
    ]),
  ),
})

const settings = object({
  $schema: string,
  model: modelRef,
  thinking: oneOf("low", "medium", "high", "xhigh", "max", "default"),
  providers: record(provider),
  shell: oneOf("auto", "bash", "powershell"),
  tools: object({ disabled: list(string) }),
  fileRewind: object({ enabled: boolean, maxFileBytes: integer(1), quotaBytes: integer(1) }),
  commandAliases,
  maxParallelTools: integer(1),
  compact: object({ threshold: number, model: modelRef, layout: oneOf("tail", "recent-user") }),
  context: object({
    outputs: object({ saveAbove: integer(4000), previewChars: integer(500), quotaMB: integer(1) }),
    dedupeReads: boolean,
    aging: object({
      enabled: boolean,
      start: share,
      target: share,
      minSavedTokens: integer(0),
      keepTurns: integer(1),
      keepSteps: integer(1),
      afterTurns: integer(0),
    }),
  }),
  retry: object({
    attempts: integer(0),
    baseDelayMs: integer(0),
    maxDelayMs: integer(0),
    firstContentTimeoutMs: integer(0),
    idleTimeoutMs: integer(0),
    nativeCompactionTimeoutMs: integer(0),
  }),
  mcpServers: record(anyObject),
  extensions: record(anyObject),
  mcpTrustedProjects: list(string),
  packages: object({
    disabled: list(string),
    trustedProjects: list(string),
    untrustedProjects: list(string),
  }),
  skills: object({ dirs: list(string) }),
  web: object({
    nativeSearch: boolean,
    search: object({
      backend: webBackend,
      fallback: list(webBackend),
      maxResults: integer(1),
      timeoutMs: integer(1),
      exa: object({ url: string, apiKeyEnv: string }),
      brave: object({ apiKeyEnv: string }),
      tavily: object({ apiKeyEnv: string, searchDepth: oneOf("basic", "advanced") }),
      searxng: object({ url: string }),
    }),
    fetch: object({
      maxChars: integer(1),
      maxBytes: integer(1),
      timeoutMs: integer(1),
      allowPrivateNetwork: boolean,
    }),
  }),
  agents: record(object({ model: modelRef })),
  sessions: object({ autoTitle: boolean }),
  subagents: object({ maxDepth: integer(1), maxConcurrent: integer(1), background: boolean }),
  backgroundJobs: object({
    maxRunning: integer(1),
    bufferChars: integer(1000),
    maxLogBytes: integer(0),
    printWaitMs: integer(1),
  }),
  budget: object({ tokens: integer(1), costUsd: number }),
  merge: object({ reviewThreshold: object({ lines: integer(0), files: integer(0) }) }),
  tui: object({
    mode: oneOf("fullscreen", "inline"),
    theme: oneOf("auto", "dark", "light", "terminal"),
    colorDepth: oneOf("auto", "truecolor", "256", "16"),
    bell: boolean,
    title: boolean,
    progress: boolean,
    tokenSpeed: boolean,
    reflow: oneOf("auto", "on", "off"),
    submitWhileWorking: oneOf("steer", "queue"),
    images: oneOf("auto", "on", "off"),
    shellOutputLines: integer(0),
  }),
  permissions,
})

/**
 * Checks parsed settings against the schema. Throws a SettingsError naming `file` and
 * each bad key; unknown keys come back as warnings.
 */
export function validateSettings(raw: unknown, file: string): { settings: Settings; warnings: string[] } {
  const { value, warnings } = run(settings, raw, file)
  return { settings: value as Settings, warnings }
}

const apiKeyAuth = object({ type: oneOf("api_key"), apiKey: string }, ["apiKey"])
const auth = record((v, key, out) => {
  if (isPlainObject(v) && v.type !== undefined && v.type !== "api_key") {
    out.warnings.push(`unknown auth type for provider "${key}" (ignored)`)
    return undefined
  }
  return apiKeyAuth(v, key, out)
})

/** Checks auth.json, accepting API keys with no type for compatibility. Returns keys by provider id. */
export function validateAuth(
  raw: unknown,
  file: string,
): { keys: Record<string, string>; warnings: string[] } {
  const { value, warnings } = run(auth, raw, file)
  const keys = Object.fromEntries(
    Object.entries(value as Record<string, { apiKey: string } | undefined>).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, v.apiKey]],
    ),
  )
  return { keys, warnings }
}

function run(check: Check, raw: unknown, file: string): { value: unknown; warnings: string[] } {
  if (!isPlainObject(raw)) throw new SettingsError(file, [`must hold a JSON object, got ${show(raw)}`])
  const out: Findings = { errors: [], warnings: [] }
  const value = check(raw, "", out)
  if (out.errors.length) throw new SettingsError(file, out.errors)
  return { value, warnings: out.warnings.map((w) => `${file}: ${w}`) }
}
