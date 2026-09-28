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

const modelOverrides = (required: string[]) =>
  object(
    {
      id: string,
      dialect: string,
      contextWindow: integer(1),
      maxOutput: integer(1),
      caps: object({
        tools: oneOf("native", "none"),
        images: boolean,
        thinking: boolean,
        promptCache: boolean,
        parallelToolCalls: boolean,
      }),
      cost: object({ input: number, output: number, cacheRead: number, cacheWrite: number }, [
        "input",
        "output",
      ]),
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
      streamUsage: boolean,
      thinking: oneOf("adaptive", "budget"),
    }),
    models: list(modelOverrides(["id"])),
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

const settings = object({
  $schema: string,
  model: modelRef,
  providers: record(provider),
  shell: oneOf("auto", "bash", "powershell"),
  tools: object({ disabled: list(string) }),
  commandAliases,
  maxParallelTools: integer(1),
  compact: object({ threshold: number, model: modelRef }),
  retry: object({ attempts: integer(0), baseDelayMs: integer(0), maxDelayMs: integer(0) }),
  mcpServers: record(anyObject),
  mcpTrustedProjects: list(string),
  skills: object({ dirs: list(string) }),
  web: object({
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
  subagents: object({ maxDepth: integer(1), maxConcurrent: integer(1), background: boolean }),
  budget: object({ tokens: integer(1), costUsd: number }),
  merge: object({ reviewThreshold: object({ lines: integer(0), files: integer(0) }) }),
  tui: object({ bell: boolean, title: boolean, progress: boolean, reflow: oneOf("auto", "on", "off") }),
})

/**
 * Checks parsed settings against the schema. Throws a SettingsError naming `file` and
 * each bad key; unknown keys come back as warnings.
 */
export function validateSettings(raw: unknown, file: string): { settings: Settings; warnings: string[] } {
  const { value, warnings } = run(settings, raw, file)
  return { settings: value as Settings, warnings }
}

const auth = record(object({ apiKey: string }, ["apiKey"]))

/** Checks auth.json: `{"<provider>": {"apiKey": "..."}}`. Returns the keys by provider id. */
export function validateAuth(
  raw: unknown,
  file: string,
): { keys: Record<string, string>; warnings: string[] } {
  const { value, warnings } = run(auth, raw, file)
  const keys = Object.fromEntries(
    Object.entries(value as Record<string, { apiKey: string }>).map(([k, v]) => [k, v.apiKey]),
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
