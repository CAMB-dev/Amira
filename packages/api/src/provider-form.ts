import type { FormOption, FormSpec, FormValues } from "./form.ts"
import type {
  ProviderAdmin,
  ProviderDraft,
  ProviderKeySource,
  ProviderModelInfo,
  ProviderVendor,
} from "./providers.ts"
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
  { value: "auth", label: "Store the key in ~/.amira/auth.json" },
  { value: "env", label: "Read it from an environment variable" },
  { value: "none", label: "No key (a local server)" },
]

const DEFAULTS = "Defaults for models the catalog does not know"

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

/** The draft the values describe; fallback id and non-editable catalog identity come from the caller. */
export function draftFromValues(values: FormValues, id?: string, catalogId?: string | false): ProviderDraft {
  const finalId = String(values.id ?? id ?? "").trim()
  const keySource = (values.keySource as ProviderKeySource | undefined) ?? "none"
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined)
  const contextWindow = num(values.contextWindow)
  const maxOutput = num(values.maxOutput)
  return {
    id: finalId,
    ...(catalogId !== undefined && catalogId !== finalId ? { catalogId } : {}),
    dialect: String(values.dialect ?? ""),
    baseUrl: String(values.baseUrl ?? "")
      .trim()
      .replace(/\/+$/, ""),
    keySource,
    ...(keySource === "auth" && typeof values.apiKey === "string" && values.apiKey
      ? { apiKey: values.apiKey }
      : {}),
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
 * not know, and an opt-in connection test. Full-screen forms fetch models when ready on add
 * or when editing a provider with no models; dialogs keep fetching manual. `initial` fills
 * in a new provider's form, such as the protocol picked before it.
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
  const draft = (values: FormValues) => draftFromValues(values, existing?.id, start.catalogId)
  return {
    title: editing ? `Edit provider ${existing.id}` : "Add a provider",
    description: editing
      ? "Changes go to your settings.json; a new key goes to ~/.amira/auth.json."
      : "Saved to your settings.json; a key goes to ~/.amira/auth.json, which only you can read.",
    submitLabel: "Save",
    sections: [
      { title: "Provider" },
      { title: "API key" },
      { title: "Models", help: "Fetch them from the provider, or type ids into the list." },
      { title: DEFAULTS, optional: true },
      { title: "Check" },
    ],
    fields: [
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
        help: "Non-loopback HTTP would send the key unencrypted. Use Fetch models manually.",
        validate: validateBaseUrl,
      },
      {
        type: "select",
        id: "keySource",
        label: "Key",
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
        placeholder: stored ? `leave empty to keep the stored key (${stored})` : "paste the key",
        help: stored ? `A key is stored (${stored}); typing one replaces it.` : "Shown masked, never logged.",
      },
      {
        type: "text",
        id: "apiKeyEnv",
        label: "Environment variable",
        section: "API key",
        when: { field: "keySource", is: "env" },
        required: true,
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
                  { field: "id", when: { keySource: "auth", apiKey: "" } },
                ],
                ready: (values: FormValues) => {
                  const d = draft(values)
                  if (
                    !dialects.some((option) => option.value === d.dialect) ||
                    validateBaseUrl(d.baseUrl) ||
                    !safeAutoFetchUrl(d.baseUrl)
                  )
                    return false
                  if (values.keySource === "none") return true
                  if (values.keySource === "auth") return !!(d.apiKey?.trim() || admin.storedKeyHint(d.id))
                  const env = d.apiKeyEnv ?? ""
                  return (
                    values.keySource === "env" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(env) && admin.envIsSet(env)
                  )
                },
              },
            }
          : {}),
        help: "Lists models from the provider with the key above; models.dev adds context window and price.",
        run: async ({ values, signal, progress }) => {
          const d = draft(values)
          progress(`asking ${d.baseUrl || "the provider"}…`)
          const models = await admin.listModels(d, signal)
          const inCatalog = models.filter((m) => m.inCatalog).length
          return {
            message: models.length
              ? `The provider listed ${models.length} models; models.dev adds context window and price for ${inCatalog}. Pick them in the list below.`
              : "The provider listed no models; type their ids into the list below.",
            tone: models.length ? "success" : "warning",
            options: {
              models: models.map((m) => ({
                value: m.id,
                ...(m.name && m.name !== m.id ? { label: `${m.id} (${m.name})` } : {}),
                ...(modelDescription(m) ? { description: modelDescription(m) } : {}),
              })),
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
        options: known.map((m) => ({ value: m.id, description: modelDescription(m) })),
        default: startModels,
        help: "Space picks · type an id and press Enter to add one the list lacks.",
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
        type: "action",
        id: "testConnection",
        label: "Test connection",
        section: "Check",
        help: "Optional: sends one tiny request (at most 16 tokens) to the first picked model.",
        run: async ({ values, signal, progress }) => {
          const d = draft(values)
          const model = d.models[0]
          if (!model) return { message: "Pick or type a model first.", tone: "warning" }
          progress(`sending a tiny request to ${model}…`)
          const r = await admin.test(d, model, signal)
          return { message: r.message, tone: r.ok ? "success" : "error" }
        },
      },
    ],
  }
}
