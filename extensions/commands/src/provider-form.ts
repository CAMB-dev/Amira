import type {
  FormOption,
  FormSpec,
  FormValues,
  ProviderAdmin,
  ProviderDraft,
  ProviderKeySource,
  ProviderModelInfo,
} from "@amira/api"

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

/** The draft the values describe; `id` comes from the provider edited when the form has none. */
export function draftFromValues(values: FormValues, id?: string): ProviderDraft {
  const keySource = (values.keySource as ProviderKeySource | undefined) ?? "none"
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined)
  const contextWindow = num(values.contextWindow)
  const maxOutput = num(values.maxOutput)
  return {
    id: String(values.id ?? id ?? "").trim(),
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
  Pick<ProviderDraft, "dialect" | "id" | "baseUrl" | "keySource" | "apiKeyEnv" | "models">
>

/**
 * The form of /provider add and /provider edit: where the provider is, how it gets its key,
 * which models it offers (fetched from it, or typed), defaults for models the catalog does
 * not know, and an opt-in connection test. Nothing is sent anywhere unless the user presses
 * Fetch models or Test connection. `initial` fills in a new provider's form, such as the
 * protocol picked before it.
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
          dialect: initial.dialect ?? "",
          baseUrl: initial.baseUrl ?? "",
          keySource: "none",
          models: startModels,
        },
        startModels,
      )
    : []
  const draft = (values: FormValues) => draftFromValues(values, existing?.id)
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
        validate: (v) => {
          try {
            const u = new URL(v.trim())
            return u.protocol === "http:" || u.protocol === "https:"
              ? undefined
              : "must start with http:// or https://"
          } catch {
            return "must be a URL, e.g. https://api.example.com/v1"
          }
        },
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
        help: "Asks the provider which models it has, with the key above.",
        run: async ({ values, signal, progress }) => {
          const d = draft(values)
          progress(`asking ${d.baseUrl || "the provider"}…`)
          const models = await admin.listModels(d, signal)
          const inCatalog = models.filter((m) => m.inCatalog).length
          return {
            message: models.length
              ? `Found ${models.length} models; ${inCatalog} are in the model catalog. Pick them in the list below.`
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
        placeholder: "128000",
        ...(existing?.defaults?.contextWindow ? { default: existing.defaults.contextWindow } : {}),
      },
      {
        type: "number",
        id: "maxOutput",
        label: "Max output (tokens)",
        section: DEFAULTS,
        integer: true,
        min: 1,
        placeholder: "8192",
        ...(existing?.defaults?.maxOutput ? { default: existing.defaults.maxOutput } : {}),
      },
      {
        type: "checkbox",
        id: "thinking",
        label: "Thinking (reasoning)",
        section: DEFAULTS,
        default: existing?.defaults?.thinking ?? false,
      },
      {
        type: "checkbox",
        id: "images",
        label: "Images in prompts",
        section: DEFAULTS,
        default: existing?.defaults?.images ?? false,
      },
      {
        type: "checkbox",
        id: "promptCache",
        label: "Prompt cache markers",
        section: DEFAULTS,
        default: existing?.defaults?.promptCache ?? false,
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
