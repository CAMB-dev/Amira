import {
  type FormActionContext,
  type FormActionResult,
  type FormOption,
  type FormSpec,
  type FormValues,
  formDefaults,
} from "./form.ts"
import { maskedEntry } from "./internal/provider-form-preview.ts"
import type {
  ProviderAdmin,
  ProviderDraft,
  ProviderKeySource,
  ProviderModelInfo,
  ProviderVendor,
} from "./providers.ts"
import type { ModelSettings, ProviderSettings } from "./settings.ts"
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  DEFAULT_MODEL_IMAGES,
  DEFAULT_MODEL_PROMPT_CACHE,
  DEFAULT_MODEL_THINKING,
} from "./settings-defaults.ts"

/** What each protocol is, next to its id wherever one is picked. */
export const DIALECT_NOTES: Record<string, string> = {
  "openai-chat": "OpenAI-compatible chat completions (most providers, local servers)",
  "openai-responses": "OpenAI Responses API",
  "anthropic-messages": "Anthropic Messages API",
  "google-gemini": "Google Gemini API",
}

const KEY_CHOICES: FormOption[] = [
  { value: "auth", label: "auth.json" },
  { value: "env", label: "Environment variable" },
  { value: "none", label: "No key" },
]

const DEFAULTS = "Defaults for models the catalog does not know"
const ADVANCED = "Advanced"
const CUSTOM = "__custom__"
const POPULAR = ["anthropic", "openai", "google", "deepseek", "openrouter", "groq", "mistral", "xai"]

const COMPAT = [
  {
    key: "maxTokensField",
    label: "Output token field",
    dialects: ["openai-chat"],
    choices: ["max_tokens", "max_completion_tokens"],
  },
  { key: "streamUsage", label: "Stream usage", dialects: ["openai-chat"], choices: ["true", "false"] },
  {
    key: "webSearch",
    label: "Hosted web search",
    dialects: ["openai-responses", "anthropic-messages", "google-gemini"],
    choices: ["true", "false"],
  },
  {
    key: "thinking",
    label: "Thinking request style",
    dialects: ["anthropic-messages"],
    choices: ["adaptive", "budget"],
  },
  {
    key: "thinkingDisplay",
    label: "Thinking display",
    dialects: ["anthropic-messages"],
    choices: ["summarized", "omitted"],
  },
  {
    key: "compaction",
    label: "Server-side compaction",
    dialects: ["openai-responses", "anthropic-messages"],
    choices: ["auto", "on", "off"],
  },
] as const

function headerLines(value: unknown): Record<string, string> {
  return Object.fromEntries(
    String(value ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }),
  )
}

function fastOverrides(value: unknown): Record<string, ModelSettings> {
  const parsed = JSON.parse(String(value ?? "").trim() || "{}") as Record<string, ModelSettings["fast"]>
  return Object.fromEntries(Object.entries(parsed).map(([id, fast]) => [id, { fast }]))
}

function validateFast(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value.trim() || "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    for (const [id, fast] of Object.entries(parsed)) {
      if (!id.trim()) throw new Error()
      if (fast === false) continue
      if (!fast || typeof fast !== "object" || Array.isArray(fast)) throw new Error()
      const allowed =
        fast.kind === "anthropic-speed" ? ["kind"] : ["kind", "value", "textOnly", "responseHeader"]
      if (Object.keys(fast).some((key) => !allowed.includes(key))) throw new Error()
      if (
        fast.kind !== "anthropic-speed" &&
        (fast.kind !== "service-tier" || typeof fast.value !== "string" || !fast.value.trim())
      )
        throw new Error()
      if (fast.textOnly !== undefined && typeof fast.textOnly !== "boolean") throw new Error()
      if (fast.responseHeader !== undefined && typeof fast.responseHeader !== "string") throw new Error()
    }
  } catch {
    return 'Use a JSON map of model IDs to false, {"kind":"anthropic-speed"}, or {"kind":"service-tier","value":"priority","textOnly":true,"responseHeader":"x-tier"}.'
  }
}

function compatValues(values: FormValues, base?: ProviderSettings["compat"]): ProviderSettings["compat"] {
  const compat = { ...base }
  for (const option of COMPAT) {
    const value = values[`compat_${option.key}`]
    if (value === undefined || !(option.dialects as readonly string[]).includes(String(values.dialect)))
      continue
    delete compat[option.key]
    if (value)
      Object.assign(compat, { [option.key]: value === "true" ? true : value === "false" ? false : value })
  }
  return compat
}

/** "128k", "1M". */
function tokens(n: number): string {
  return n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n)
}

/** What the checklist says next to a model. */
export function modelDescription(m: ProviderModelInfo): string {
  const parts = [
    ...(m.contextWindow ? [`${tokens(m.contextWindow)} ctx`] : []),
    ...(m.cost ? [`$${m.cost.input}/$${m.cost.output} per M`] : []),
  ]
  if (!m.inCatalog)
    parts.push(m.contextWindow ? "limits from the provider" : "not in catalog: defaults apply")
  return parts.join(" · ")
}

/** Compact limits and catalog prices in the checklist's right-aligned column. */
function modelOption(m: ProviderModelInfo): FormOption {
  const context = m.contextWindow ? tokens(m.contextWindow).replace("k", "K") : ""
  const price = m.inCatalog && m.cost ? `$${m.cost.input}/$${m.cost.output}` : ""
  const detail = [context, ...(price ? [price] : [])]
  return {
    value: m.id,
    ...(m.name && m.name !== m.id ? { label: `${m.id} (${m.name})` } : {}),
    ...(context || price ? { detail } : {}),
  }
}

/** Converts form values; a supplied id is fixed on edit. Existing overrides survive fast-only edits. */
export function draftFromValues(
  values: FormValues,
  id?: string,
  catalogId?: string | false,
  existing?: ProviderDraft,
): ProviderDraft {
  const finalId = String(id ?? values.id ?? "").trim()
  const identity =
    typeof values.vendor === "string" ? (values.vendor === CUSTOM ? false : values.vendor) : catalogId
  const modelOverrides = structuredClone(existing?.modelOverrides ?? {})
  const fast = fastOverrides(values.modelFast)
  for (const [model, override] of Object.entries(fast))
    modelOverrides[model] = { ...modelOverrides[model], ...override }
  if (values.modelFast !== undefined)
    for (const model of Object.keys(modelOverrides)) {
      if (!Object.hasOwn(fast, model)) delete modelOverrides[model]!.fast
    }
  const headers = values.headers === undefined ? existing?.headers : headerLines(values.headers)
  const apiKeyEnvFallbacks =
    values.apiKeyEnvFallbacks === undefined
      ? existing?.apiKeyEnvFallbacks
      : String(values.apiKeyEnvFallbacks)
          .split(/[\s,]+/)
          .filter(Boolean)
  const compat = compatValues(values, existing?.compat)
  const keySource = (values.keySource as ProviderKeySource | undefined) ?? "none"
  const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : ""
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined)
  const contextWindow = num(values.contextWindow)
  const maxOutput = num(values.maxOutput)
  return {
    id: finalId,
    ...(identity !== undefined ? { catalogId: identity } : {}),
    ...(headers ? { headers } : {}),
    ...(apiKeyEnvFallbacks ? { apiKeyEnvFallbacks } : {}),
    ...(Object.keys(compat ?? {}).length ||
    existing?.compat ||
    Object.keys(values).some((key) => key.startsWith("compat_"))
      ? { compat }
      : {}),
    ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}),
    dialect: String(values.dialect ?? ""),
    baseUrl: String(values.baseUrl ?? "")
      .trim()
      .replace(/\/+$/, ""),
    keySource,
    ...(keySource === "auth" && apiKey ? { apiKey } : {}),
    ...(keySource === "env" ? { apiKeyEnv: String(values.apiKeyEnv ?? "").trim() } : {}),
    models: Array.isArray(values.models) ? values.models : [],
    defaults: {
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      thinking: values.thinking === true,
      images: values.images === true,
      promptCache: values.promptCache === true,
    },
  }
}

/** What a new provider's form starts with, e.g. from `amira provider add` flags. */
export type ProviderFormInitial = Partial<
  Pick<ProviderDraft, "dialect" | "id" | "catalogId" | "baseUrl" | "keySource" | "apiKeyEnv" | "models">
>

/** A searchable vendor label; unsupported vendors still provide id and key presets. */
export function providerVendorLabel(vendor: ProviderVendor): string {
  return `${vendor.name} (${vendor.id})${vendor.dialect ? "" : " — pick the protocol yourself"}`
}

/** Presets for adding a catalog vendor, without reading or exposing an API key. */
export function providerVendorInitial(admin: ProviderAdmin, vendor: ProviderVendor): ProviderFormInitial {
  let id = vendor.id
  for (let n = 2; admin.exists(id); n++) id = `${vendor.id}-${n}`
  const setEnv = vendor.env.find((name) => admin.envIsSet(name))
  const apiKeyEnv = setEnv ?? vendor.env[0]
  return {
    id,
    catalogId: vendor.id,
    ...(vendor.dialect ? { dialect: vendor.dialect } : {}),
    ...(vendor.baseUrl ? { baseUrl: vendor.baseUrl } : {}),
    keySource: setEnv ? "env" : "auth",
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(vendor.models ? { models: [...vendor.models] } : {}),
  }
}

function validateBaseUrl(value: string): string | undefined {
  const placeholder = value.match(/\$\{[^}]*\}?/)?.[0]
  if (placeholder) return `replace ${placeholder} in the base URL with its value`
  try {
    const url = new URL(value.trim())
    return url.protocol === "http:" || url.protocol === "https:"
      ? undefined
      : "must start with http:// or https://"
  } catch {
    return "must be a URL, e.g. https://api.example.com/v1"
  }
}

/** Automatic requests may send a key without a click, so remote endpoints must use TLS. */
function safeAutoFetchUrl(value: string): boolean {
  const url = new URL(value)
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname)))
  )
}

/**
 * The form of /provider add and /provider edit: where the provider is, how it gets its key,
 * which models it offers (fetched from it, or typed), defaults for models the catalog does
 * not know, advanced overrides and a connection test before saving. Full-screen forms fetch
 * models when ready on add or when editing a provider with no models. Remote HTTP and
 * potentially billed probes require explicit consent. `initial` supplies command flags.
 */
export function providerFormSpec(
  admin: ProviderAdmin,
  existing?: ProviderDraft,
  initial: ProviderFormInitial = {},
): FormSpec {
  const editing = existing !== undefined
  const start: ProviderFormInitial = existing ?? initial
  const stored = existing ? admin.storedKeyHint(existing.id) : undefined
  const dialects = admin.dialects().map((d) => ({
    value: d,
    ...(DIALECT_NOTES[d] ? { description: DIALECT_NOTES[d] } : {}),
  }))
  const startModels = start.models ?? []
  const known = startModels.length
    ? admin.describeModels(
        existing ?? {
          id: initial.id ?? "",
          ...(initial.catalogId !== undefined ? { catalogId: initial.catalogId } : {}),
          dialect: initial.dialect ?? "",
          baseUrl: initial.baseUrl ?? "",
          keySource: "none",
          models: startModels,
        },
        startModels,
      )
    : []
  const vendors = admin.cachedVendors?.() ?? []
  const vendorOptions = [
    ...POPULAR.flatMap((id) => {
      const vendor = vendors.find((v) => v.id === id)
      return vendor ? [{ value: id, label: providerVendorLabel(vendor), group: "Popular" }] : []
    }),
    ...vendors
      .filter((v) => !POPULAR.includes(v.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((v) => ({ value: v.id, label: providerVendorLabel(v), group: "All vendors" })),
    { value: CUSTOM, label: "Custom (choose protocol)", group: "All vendors" },
  ]
  const initialVendor =
    start.catalogId === false
      ? CUSTOM
      : (start.catalogId ??
        (existing ? existing.id : vendors.some((v) => v.id === start.id) ? start.id : CUSTOM))
  if (initialVendor && !vendorOptions.some((v) => v.value === initialVendor))
    vendorOptions.unshift({ value: initialVendor, label: initialVendor, group: "All vendors" })
  let defaults: FormValues = {}
  const draft = (values: FormValues) =>
    draftFromValues({ ...defaults, ...values }, existing?.id, start.catalogId, existing)
  // Only endpoint inputs affect a model-list request. Defaults, fast options and unused key
  // fields must not revoke consent or invalidate a connection test.
  const requestSettings = (values: FormValues) => {
    const d = draft({ ...values, modelFast: "{}" })
    return {
      dialect: d.dialect,
      baseUrl: d.baseUrl,
      headers: d.headers,
      compat: d.compat,
      keySource: d.keySource,
      ...(d.keySource === "auth" ? { apiKey: d.apiKey, ...(!d.apiKey ? { id: d.id } : {}) } : {}),
      ...(d.keySource === "env" ? { apiKeyEnv: d.apiKeyEnv, apiKeyEnvFallbacks: d.apiKeyEnvFallbacks } : {}),
    }
  }
  const fingerprint = (values: FormValues) => {
    const d = draft({ ...values, modelFast: "{}" })
    return JSON.stringify({ ...requestSettings(values), model: d.models[0], catalogId: d.catalogId })
  }
  let tested: { fingerprint: string; ok: boolean } | undefined
  let currentFingerprint: string | undefined
  let testRevision = 0
  const pending = new Map<
    string,
    {
      controller: AbortController
      users: number
      result: Promise<boolean>
    }
  >()
  const runTest = async ({ values, signal, progress }: FormActionContext): Promise<FormActionResult> => {
    signal.throwIfAborted()
    const d = draft(values)
    const model = d.models[0]
    if (!model)
      return {
        message: "No model selected. Add a model to test, or save without a connection test.",
        tone: "warning",
      }
    if (validateBaseUrl(d.baseUrl)) return { message: "Fix the base URL before testing.", tone: "error" }
    if (!safeAutoFetchUrl(d.baseUrl) && values.httpConsent !== true)
      return {
        message:
          "Allow unencrypted HTTP requests before sending credentials to this remote server, or use HTTPS.",
        tone: "error",
        values: { httpConsent: false },
      }
    const info = admin.describeModels(d, [model]).find((m) => m.id === model)
    const free = info?.cost?.input === 0 && info.cost.output === 0
    if (!free && values.testConsent !== true)
      return {
        message:
          "This tiny connection test may be billed (price paid or unknown). Allow a potentially billed test to continue.",
        tone: "error",
        values: { testConsent: false },
      }
    const stamp = fingerprint(values)
    const revision = testRevision
    currentFingerprint = stamp
    progress(`sending a tiny request to ${model}…`)
    let probe = pending.get(stamp)
    if (!probe) {
      const controller = new AbortController()
      const result = (async () => {
        try {
          return (await admin.test(d, model, controller.signal)).ok
        } catch {
          return false
        }
      })()
      probe = { controller, users: 0, result }
      pending.set(stamp, probe)
    }
    const request = probe
    request.users++
    let cancel = () => {}
    try {
      signal.throwIfAborted()
      const ok = await Promise.race([
        request.result,
        new Promise<never>((_, reject) => {
          cancel = () => reject(signal.reason)
          signal.addEventListener("abort", cancel, { once: true })
        }),
      ])
      signal.throwIfAborted()
      if (revision !== testRevision || currentFingerprint !== stamp)
        return { message: "Inputs changed; test again with the current settings.", tone: "error" }
      tested = { fingerprint: stamp, ok }
      return {
        message: ok
          ? "Connection test passed."
          : "Connection test failed. Fix the protocol, base URL, key or model and retry, or select Save anyway.",
        tone: ok ? "success" : "error",
        ...(!ok ? { values: { saveAnyway: false } } : {}),
      }
    } finally {
      signal.removeEventListener("abort", cancel)
      if (--request.users === 0) {
        request.controller.abort()
        if (pending.get(stamp) === request) pending.delete(stamp)
      }
    }
  }
  const spec: FormSpec = {
    title: editing ? `Edit provider · ${existing.id}` : "Add provider",
    layout: "card",
    description: editing
      ? "Changes go to your settings.json; a new key goes to ~/.amira/auth.json."
      : "Saved to your settings.json; a key goes to ~/.amira/auth.json, which only you can read.",
    submitLabel: "Save",
    sections: [
      { title: "Provider" },
      { title: "API key" },
      { title: "Models" },
      { title: DEFAULTS, optional: true, collapsed: true },
      { title: ADVANCED, optional: true, collapsed: true },
      { title: "Check" },
    ],
    fields: [
      {
        type: "select",
        id: "vendor",
        label: "Vendor",
        section: "Provider",
        options: vendorOptions,
        default: initialVendor ?? CUSTOM,
        help: "Search catalog vendors, or choose Custom. You can change the protocol below.",
      },
      ...(editing
        ? []
        : [
            {
              type: "text" as const,
              id: "id",
              label: "Id",
              section: "Provider",
              required: true,
              placeholder: "e.g. my-provider",
              pattern: "[a-z0-9][a-z0-9._-]*",
              patternMessage: "use lower-case letters, digits and . _ -",
              help: "Models are then chosen as <id>/<model>.",
              ...(initial.id ? { default: initial.id } : {}),
              validate: (v: string) =>
                admin.exists(v) ? `"${v}" exists already; change it with /provider edit ${v}` : undefined,
            },
          ]),
      {
        type: "select",
        id: "dialect",
        label: "Protocol",
        section: "Provider",
        options: dialects,
        default: start.dialect ?? "openai-chat",
      },
      {
        type: "text",
        id: "baseUrl",
        label: "Base URL",
        section: "Provider",
        required: true,
        placeholder: "https://api.example.com/v1",
        ...(start.baseUrl ? { default: start.baseUrl } : {}),
        help: "Remote HTTP sends credentials unencrypted. Use HTTPS or explicitly allow HTTP below.",
        validate: validateBaseUrl,
      },
      {
        type: "checkbox",
        id: "httpConsent",
        label: "Allow unencrypted HTTP requests to remote servers",
        section: "Provider",
        help: "Required before fetching or testing a non-loopback HTTP endpoint. Changing request settings resets this permission.",
      },
      {
        type: "select",
        id: "keySource",
        label: "Key source",
        section: "API key",
        options: KEY_CHOICES,
        default: start.keySource ?? "auth",
      },
      {
        type: "secret",
        id: "apiKey",
        label: "API key",
        section: "API key",
        when: { field: "keySource", is: "auth" },
        placeholder: stored
          ? `leave empty to keep the current key (stored: ${stored})`
          : editing
            ? "leave empty to keep the current key"
            : "paste the key",
        help: stored
          ? `auth.json has a key (${stored}); a new key replaces it.`
          : "Shown masked, never logged.",
      },
      {
        type: "text",
        id: "apiKeyEnv",
        label: "Environment variable",
        section: "API key",
        when: { field: "keySource", is: "env" },
        placeholder: "e.g. MY_PROVIDER_API_KEY",
        pattern: "[A-Za-z_][A-Za-z0-9_]*",
        patternMessage: "letters, digits and _",
        ...(start.apiKeyEnv ? { default: start.apiKeyEnv } : {}),
        help: "Read each time a request is sent.",
      },
      {
        type: "action",
        id: "fetchModels",
        label: "Fetch models",
        section: "Models",
        recommended: true,
        ...(!editing || !existing.models.length
          ? {
              auto: {
                watch: [
                  "dialect",
                  "baseUrl",
                  "keySource",
                  "apiKey",
                  "apiKeyEnv",
                  "httpConsent",
                  "headers",
                  "apiKeyEnvFallbacks",
                  { field: "id", when: { keySource: "auth", apiKey: "" } },
                ],
                ready: (values: FormValues) => {
                  if (validateFast(String(values.modelFast ?? ""))) return false
                  const d = draft(values)
                  if (
                    !dialects.some((option) => option.value === values.dialect) ||
                    validateBaseUrl(d.baseUrl) ||
                    (!safeAutoFetchUrl(d.baseUrl) && values.httpConsent !== true)
                  )
                    return false
                  if (values.keySource === "none") return true
                  if (values.keySource === "auth") return !!(d.apiKey?.trim() || admin.storedKeyHint(d.id))
                  const env = d.apiKeyEnv ?? ""
                  return (
                    values.keySource === "env" &&
                    (!env || /^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) &&
                    [env, ...(d.apiKeyEnvFallbacks ?? [])].some(
                      (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && admin.envIsSet(name),
                    )
                  )
                },
              },
            }
          : {}),
        run: async ({ values, signal, progress }) => {
          const d = draft(values)
          signal.throwIfAborted()
          if (validateBaseUrl(d.baseUrl))
            return { message: "Fix the base URL before fetching models.", tone: "error" }
          if (!safeAutoFetchUrl(d.baseUrl) && values.httpConsent !== true)
            return {
              message:
                "Allow unencrypted HTTP requests before sending credentials to this remote server, or use HTTPS.",
              tone: "error",
            }
          progress("asking the provider…")
          const models = await admin.listModels(d, signal)
          signal.throwIfAborted()
          const inCatalog = models.filter((m) => m.inCatalog).length
          return {
            message: models.length
              ? `${models.length} models listed · models.dev details for ${inCatalog}.`
              : "No models listed; enter model IDs below.",
            tone: models.length ? "success" : "warning",
            options: {
              models: [
                ...models.map(modelOption),
                ...d.models.filter((id) => !models.some((m) => m.id === id)).map((value) => ({ value })),
              ],
            },
          }
        },
      },
      {
        type: "multiselect",
        id: "models",
        label: "Models",
        section: "Models",
        allowCustom: true,
        options: known.map(modelOption),
        default: startModels,
        help: "Type to filter · enter adds an unlisted id. Prices are input/output USD per million tokens.",
      },
      {
        type: "number",
        id: "contextWindow",
        label: "Context window (tokens)",
        section: DEFAULTS,
        integer: true,
        min: 1,
        placeholder: String(DEFAULT_CONTEXT_WINDOW),
        ...(existing?.defaults?.contextWindow ? { default: existing.defaults.contextWindow } : {}),
      },
      {
        type: "number",
        id: "maxOutput",
        label: "Max output (tokens)",
        section: DEFAULTS,
        integer: true,
        min: 1,
        placeholder: String(DEFAULT_MAX_OUTPUT),
        ...(existing?.defaults?.maxOutput ? { default: existing.defaults.maxOutput } : {}),
      },
      {
        type: "checkbox",
        id: "thinking",
        label: "Thinking (reasoning)",
        section: DEFAULTS,
        default: existing?.defaults?.thinking ?? DEFAULT_MODEL_THINKING,
      },
      {
        type: "checkbox",
        id: "images",
        label: "Images in prompts",
        section: DEFAULTS,
        default: existing?.defaults?.images ?? DEFAULT_MODEL_IMAGES,
      },
      {
        type: "checkbox",
        id: "promptCache",
        label: "Prompt cache markers",
        section: DEFAULTS,
        default: existing?.defaults?.promptCache ?? DEFAULT_MODEL_PROMPT_CACHE,
      },
      {
        type: "textarea",
        id: "headers",
        label: "Request headers",
        section: ADVANCED,
        default: Object.entries(existing?.headers ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal environment-reference syntax.
        help: "One NAME=value per line. ${ENV_VAR} references are resolved when sending. Header values are masked in the preview.",
        validate: (value) =>
          value
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .some((line) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=/.test(line))
            ? "Use one header per line: NAME=value."
            : undefined,
      },
      {
        type: "text",
        id: "apiKeyEnvFallbacks",
        label: "Fallback key environment variables",
        section: ADVANCED,
        default: existing?.apiKeyEnvFallbacks?.join(", ") ?? "",
        help: "Tried in order after the primary variable. Separate names with commas or spaces.",
        validate: (value) =>
          value
            .split(/[\s,]+/)
            .filter(Boolean)
            .some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            ? "Use environment variable names separated by commas or spaces."
            : undefined,
      },
      ...COMPAT.map((option) => ({
        type: "select" as const,
        id: `compat_${option.key}`,
        label: option.label,
        section: ADVANCED,
        options: [{ value: "", label: "Default" }, ...option.choices.map((value) => ({ value }))],
        default: existing?.compat?.[option.key] === undefined ? "" : String(existing.compat[option.key]),
        when: { field: "dialect", is: [...option.dialects] },
      })),
      {
        type: "textarea",
        id: "modelFast",
        label: "Per-model fast options",
        section: ADVANCED,
        default: JSON.stringify(
          Object.fromEntries(
            Object.entries(existing?.modelOverrides ?? {})
              .filter(([, model]) => model.fast !== undefined)
              .map(([id, model]) => [id, model.fast]),
          ),
          null,
          2,
        ),
        help: 'JSON map of model IDs to /fast descriptors: false, {"kind":"anthropic-speed"}, or {"kind":"service-tier","value":"priority"}. Other model overrides are preserved.',
        validate: validateFast,
      },
      {
        type: "checkbox",
        id: "testConsent",
        label: "Allow a potentially billed connection test",
        section: "Check",
        help: "Save tests the first selected model with a tiny request (at most 16 output tokens). Permission is needed only for paid or unknown prices; known-free models need none.",
      },
      {
        type: "action",
        id: "testConnection",
        label: "Test connection",
        buttonLabel: "Test",
        placement: "footer",
        section: "Check",
        run: runTest,
      },
      {
        type: "checkbox",
        id: "saveAnyway",
        label: "Save anyway after a failed connection test",
        section: "Check",
        help: "Use only after a failed test. Fix the protocol, base URL, credentials or model and test again when possible.",
      },
    ],
    visible: (fieldId, values) => {
      if (fieldId === "httpConsent") {
        const url = String(values.baseUrl ?? start.baseUrl ?? "")
        return !validateBaseUrl(url) && !safeAutoFetchUrl(url)
      }
      if (fieldId === "testConsent") {
        const d = draft({ ...values, modelFast: "{}" })
        const model = d.models[0]
        if (!model) return false
        const cost = admin.describeModels(d, [model])[0]?.cost
        return cost?.input !== 0 || cost.output !== 0
      }
      if (fieldId === "saveAnyway") return tested?.fingerprint === fingerprint(values) && !tested.ok
      return true
    },
    preview: (values) => {
      let d: ProviderDraft
      try {
        d = draft(values)
      } catch {
        return ["Fix the advanced JSON to preview settings."]
      }
      let persisted: ProviderSettings | undefined
      try {
        persisted = admin.preview?.(d)
      } catch {
        return ["Complete valid provider details to preview settings."]
      }
      const entry = persisted ?? {
        dialect: d.dialect,
        baseUrl: d.baseUrl,
        ...(d.catalogId !== undefined ? { catalogId: d.catalogId } : {}),
        ...(d.keySource === "env" ? { apiKeyEnv: d.apiKeyEnv } : {}),
        ...(d.apiKeyEnvFallbacks ? { apiKeyEnvFallbacks: d.apiKeyEnvFallbacks } : {}),
        ...(d.headers ? { headers: d.headers } : {}),
        ...(d.compat ? { compat: d.compat } : {}),
        models: d.models.map((id) => ({ ...d.modelOverrides?.[id], id })),
        defaultModel: {
          contextWindow: d.defaults?.contextWindow,
          maxOutput: d.defaults?.maxOutput,
          caps: {
            thinking: d.defaults?.thinking,
            images: d.defaults?.images,
            promptCache: d.defaults?.promptCache,
          },
        },
      }
      return [
        "settings.json",
        JSON.stringify({ providers: { [d.id || "<id>"]: maskedEntry(entry) } }, null, 2),
        ...(d.keySource === "auth"
          ? [
              d.apiKey
                ? `key → auth.json: ${d.id || "<id>"} → •••• (new key)`
                : `key → auth.json: ${d.id || "<id>"} → current key unchanged`,
            ]
          : ["auth.json: unchanged"]),
      ]
    },
    validate: (values) =>
      values.keySource === "env" &&
      !String(values.apiKeyEnv ?? "").trim() &&
      !String(values.apiKeyEnvFallbacks ?? "").trim()
        ? { apiKeyEnvFallbacks: "Set a primary environment variable or add a fallback in Advanced." }
        : undefined,
    beforeSubmit: async (ctx) => {
      if (ctx.signal.aborted) return { message: "Cancelled. Nothing was saved.", tone: "error" }
      const stamp = fingerprint(ctx.values)
      if (!draft(ctx.values).models.length) return undefined
      if (tested?.fingerprint === stamp && !pending.has(stamp)) {
        if (tested.ok || ctx.values.saveAnyway === true) return undefined
        return {
          message: "Connection test failed. Fix the settings and retry, or select Save anyway.",
          tone: "error",
        }
      }
      try {
        return await runTest(ctx)
      } catch {
        return {
          message: ctx.signal.aborted
            ? "Cancelled. Nothing was saved."
            : "Unable to test the connection. Check the settings and retry.",
          tone: "error",
        }
      }
    },
  }
  defaults = formDefaults(spec)
  const touched = new Set<string>()
  const initialPreset = vendors.find((v) => v.id === initialVendor)
  const automatic = initialPreset ? providerVendorInitial(admin, initialPreset) : {}
  for (const key of ["id", "dialect", "baseUrl", "keySource", "apiKeyEnv", "models"] as const) {
    if (
      start[key] !== undefined &&
      JSON.stringify(start[key]) !== JSON.stringify(automatic[key as keyof typeof automatic])
    )
      touched.add(key)
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  spec.change = (values, previous) => {
    const updates: FormValues = {}
    for (const key of ["id", "dialect", "baseUrl", "keySource", "apiKeyEnv", "models"]) {
      // Compare raw snapshots: revealing a hidden default is not a user edit.
      if (values[key] !== undefined && !same(values[key], previous[key])) touched.add(key)
    }
    if (values.vendor !== previous.vendor) {
      const vendor = vendors.find((v) => v.id === values.vendor)
      const next = vendor
        ? providerVendorInitial(admin, vendor)
        : { id: "", dialect: "openai-chat", baseUrl: "", keySource: "auth", apiKeyEnv: "", models: [] }
      for (const key of ["id", "dialect", "baseUrl", "keySource", "apiKeyEnv", "models"] as const) {
        if ((editing && key === "id") || touched.has(key)) continue
        updates[key] = next[key] ?? (key === "models" ? [] : key === "dialect" ? "openai-chat" : "")
      }
    }
    const stamp = fingerprint({ ...values, ...updates })
    currentFingerprint = stamp
    if (!same(requestSettings({ ...values, ...updates }), requestSettings(previous)))
      updates.httpConsent = false
    if (stamp !== fingerprint(previous)) {
      updates.testConsent = false
      updates.saveAnyway = false
      tested = undefined
      testRevision++
      pending.clear()
    }
    const ids = Array.isArray(updates.models) ? updates.models : undefined
    return {
      values: updates,
      ...(ids
        ? {
            options: { models: admin.describeModels(draft({ ...values, ...updates }), ids).map(modelOption) },
          }
        : {}),
    }
  }
  return spec
}
