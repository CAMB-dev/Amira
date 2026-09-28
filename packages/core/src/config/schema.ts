import type { Settings } from "@amira/api"
import { isPlainObject } from "./merge.ts"

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

type Check = (value: unknown, key: string, out: Findings) => void

const show = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 40 ? `${s.slice(0, 37)}...` : s
}
const expect = (want: string, ok: (v: unknown) => boolean): Check => {
  return (v, key, out) => {
    if (!ok(v)) out.errors.push(`"${key}" must be ${want}, got ${show(v)}`)
  }
}

const string = expect("a string", (v) => typeof v === "string")
const boolean = expect("true or false", (v) => typeof v === "boolean")
const number = expect("a number", (v) => typeof v === "number" && Number.isFinite(v))
const integer = (min: number) =>
  expect(`a whole number of at least ${min}`, (v) => Number.isInteger(v) && (v as number) >= min)
const oneOf = (...values: string[]) =>
  expect(`one of ${values.map((v) => `"${v}"`).join(", ")}`, (v) => values.includes(v as string))
const anyObject = expect("an object", isPlainObject)

function list(item: Check): Check {
  return (v, key, out) => {
    if (!Array.isArray(v)) return void out.errors.push(`"${key}" must be a list, got ${show(v)}`)
    for (const [i, x] of v.entries()) item(x, `${key}[${i}]`, out)
  }
}

function record(item: Check): Check {
  return (v, key, out) => {
    if (!isPlainObject(v)) return void out.errors.push(`"${key}" must be an object, got ${show(v)}`)
    for (const [k, x] of Object.entries(v)) item(x, key ? `${key}.${k}` : k, out)
  }
}

/** Known keys are checked; unknown keys only warn, so newer settings files still load. */
function object(shape: Record<string, Check>, required: string[] = []): Check {
  return (v, key, out) => {
    if (!isPlainObject(v)) return void out.errors.push(`"${key}" must be an object, got ${show(v)}`)
    const at = (k: string) => (key ? `${key}.${k}` : k)
    for (const k of required) if (v[k] === undefined) out.errors.push(`"${at(k)}" is required`)
    for (const [k, x] of Object.entries(v)) {
      const check = shape[k]
      if (check) check(x, at(k), out)
      else out.warnings.push(`unknown setting "${at(k)}" (ignored)`)
    }
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
      cost: object({ input: number, output: number, cacheRead: number, cacheWrite: number }),
    },
    required,
  )

const provider = object({
  dialect: string,
  baseUrl: string,
  apiKeyEnv: string,
  headers: record(string),
  compat: object({
    maxTokensField: oneOf("max_tokens", "max_completion_tokens"),
    streamUsage: boolean,
    thinking: oneOf("adaptive", "budget"),
  }),
  models: list(modelOverrides(["id"])),
  defaultModel: modelOverrides([]),
})

const settings = object({
  $schema: string,
  model: modelRef,
  providers: record(provider),
  shell: oneOf("auto", "bash", "powershell"),
  tools: object({ disabled: list(string) }),
  maxParallelTools: integer(1),
  compact: object({ threshold: number, model: modelRef }),
  retry: object({ attempts: integer(0) }),
  mcpServers: record(anyObject),
  skills: object({ dirs: list(string) }),
})

/**
 * Checks parsed settings against the schema. Throws a SettingsError naming `file` and
 * each bad key; unknown keys come back as warnings.
 */
export function validateSettings(raw: unknown, file: string): { settings: Settings; warnings: string[] } {
  return { settings: raw as Settings, warnings: run(settings, raw, file) }
}

const auth = record(object({ apiKey: string }, ["apiKey"]))

/** Checks auth.json: `{"<provider>": {"apiKey": "..."}}`. Returns the keys by provider id. */
export function validateAuth(
  raw: unknown,
  file: string,
): { keys: Record<string, string>; warnings: string[] } {
  const warnings = run(auth, raw, file)
  const keys = Object.fromEntries(
    Object.entries(raw as Record<string, { apiKey: string }>).map(([k, v]) => [k, v.apiKey]),
  )
  return { keys, warnings }
}

function run(check: Check, raw: unknown, file: string): string[] {
  if (!isPlainObject(raw)) throw new SettingsError(file, [`must hold a JSON object, got ${show(raw)}`])
  const out: Findings = { errors: [], warnings: [] }
  check(raw, "", out)
  if (out.errors.length) throw new SettingsError(file, out.errors)
  return out.warnings.map((w) => `${file}: ${w}`)
}
