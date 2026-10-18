// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Catalog URL placeholders are literal fixtures.
import { expect, test } from "bun:test"
import {
  autoFormActions,
  checkForm,
  type FormValues,
  formDefaults,
  isFieldVisible,
  runFormAction,
  runFormChange,
  runFormDialogs,
  toFormSchema,
} from "../src/form.ts"
import {
  draftFromValues,
  providerFormSpec,
  providerVendorInitial,
  providerVendorLabel,
} from "../src/provider-form.ts"
import type { ProviderAdmin, ProviderDraft, ProviderVendor } from "../src/providers.ts"
import type { ModelSettings, ProviderSettings } from "../src/settings.ts"

const VENDOR: ProviderVendor = {
  id: "vendor",
  name: "Vendor name",
  env: ["VENDOR_API_KEY", "ALTERNATE_KEY"],
  dialect: "openai-chat",
  baseUrl: "https://api.vendor.example/v1",
}

function fakeAdmin() {
  const seen: ProviderDraft[] = []
  const admin: ProviderAdmin = {
    dialects: () => ["openai-chat", "anthropic-messages"],
    exists: (id) => ["vendor", "vendor-2"].includes(id),
    draft: () => undefined,
    storedKeyHint: () => undefined,
    envIsSet: (name) => name === "ALTERNATE_KEY",
    listModels: async (draft) => {
      seen.push(draft)
      return []
    },
    describeModels: (draft, ids) => {
      seen.push(draft)
      return ids.map((id) => ({ id, inCatalog: true }))
    },
    test: async (draft) => {
      seen.push(draft)
      return { ok: true, latencyMs: 1, message: "OK" }
    },
    save: async () => "Saved",
    remove: async () => "Removed",
    setKey: async () => "Stored",
  }
  return { admin, seen }
}

test("provider add and edit use a card with the existing connection action in the footer", () => {
  const { admin } = fakeAdmin()
  const existing: ProviderDraft = {
    id: "my-provider",
    dialect: "openai-chat",
    baseUrl: "https://api.example/v1",
    keySource: "none",
    models: ["m"],
  }
  const adding = providerFormSpec(admin)
  const editing = providerFormSpec(admin, existing)
  expect(adding.title).toBe("Add provider")
  expect(editing.title).toBe("Edit provider · my-provider")
  for (const form of [adding, editing]) {
    expect(form.layout).toBe("card")
    expect(form.submitLabel).toBe("Save")
    const schema = toFormSchema(form)
    expect(schema.layout).toBe("card")
    expect(schema.fields.filter((field) => field.type === "action" && field.placement === "footer")).toEqual([
      {
        type: "action",
        id: "testConnection",
        label: "Test connection",
        buttonLabel: "Test",
        shortcut: "ctrl+t",
        placement: "footer",
        section: "Check",
      },
    ])
    expect(form.fields.find((field) => field.id === "fetchModels")).not.toHaveProperty("placement")
  }
})

test("vendor presets choose a unique id and the first set environment variable", () => {
  const { admin } = fakeAdmin()
  expect(providerVendorInitial(admin, VENDOR)).toEqual({
    id: "vendor-3",
    catalogId: "vendor",
    dialect: "openai-chat",
    baseUrl: "https://api.vendor.example/v1",
    keySource: "env",
    apiKeyEnv: "ALTERNATE_KEY",
  })
  admin.envIsSet = () => true
  expect(providerVendorInitial(admin, VENDOR).apiKeyEnv).toBe("VENDOR_API_KEY")
  admin.exists = () => false
  admin.envIsSet = () => false
  expect(providerVendorInitial(admin, VENDOR)).toMatchObject({
    id: "vendor",
    keySource: "auth",
    apiKeyEnv: "VENDOR_API_KEY",
  })
  expect(providerVendorInitial(admin, { id: "local", name: "Local", env: [] })).toEqual({
    id: "local",
    catalogId: "local",
    keySource: "auth",
  })
})

test("unsupported vendors keep id and key presets without choosing a protocol or endpoint", () => {
  const { admin } = fakeAdmin()
  const vendor = { id: "unsupported", name: "Unsupported", env: ["ALTERNATE_KEY"] }
  expect(providerVendorInitial(admin, vendor)).toEqual({
    id: "unsupported",
    catalogId: "unsupported",
    keySource: "env",
    apiKeyEnv: "ALTERNATE_KEY",
  })
  expect(providerVendorLabel(VENDOR)).toBe("Vendor name (vendor)")
  expect(providerVendorLabel(vendor)).toBe("Unsupported (unsupported) — pick the protocol yourself")
})

test.each([
  {
    baseUrl: "${NEON_AI_GATEWAY_BASE_URL}/v1",
    placeholder: "${NEON_AI_GATEWAY_BASE_URL}",
    replacement: "https://neon.example/v1",
  },
  {
    baseUrl: "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/compat",
    placeholder: "${CLOUDFLARE_ACCOUNT_ID}",
    replacement: "https://gateway.ai.cloudflare.com/v1/account/gateway/compat",
  },
  {
    baseUrl: "https://api.example/v1/${UNFINISHED",
    placeholder: "${UNFINISHED",
    replacement: "https://api.example/v1/account",
  },
  {
    baseUrl: "https://api.example/v1/${",
    placeholder: "${",
    replacement: "https://api.example/v1/account",
  },
])("provider form requires replacing placeholders in $baseUrl", ({ baseUrl, placeholder, replacement }) => {
  const { admin } = fakeAdmin()
  const initial = providerVendorInitial(admin, { ...VENDOR, baseUrl })
  const form = providerFormSpec(admin, undefined, initial)
  const field = form.fields.find((field) => field.id === "baseUrl")
  if (field?.type !== "text") throw new Error("Missing base URL field")
  const values = formDefaults(form)
  const message = `replace ${placeholder} in the base URL with its value`
  expect(initial.baseUrl).toBe(baseUrl)
  expect(field.default).toBe(baseUrl)
  expect(values.baseUrl).toBe(baseUrl)
  expect(field.validate?.(baseUrl, values)).toBe(message)
  expect(checkForm(form, values).errors).toEqual({ baseUrl: message })
  const replaced = { ...values, baseUrl: replacement }
  expect(field.validate?.(replacement, replaced)).toBeUndefined()
  expect(checkForm(form, replaced).errors).toEqual({})
})

test("placeholder endpoints stay visible when the protocol must be chosen manually", () => {
  const { admin } = fakeAdmin()
  const initial = providerVendorInitial(admin, {
    id: "unsupported",
    name: "Unsupported",
    env: [],
    baseUrl: "${ENDPOINT}/v1",
  })
  expect(initial.dialect).toBeUndefined()
  expect(initial.baseUrl).toBe("${ENDPOINT}/v1")
  const field = providerFormSpec(admin, undefined, initial).fields.find((f) => f.id === "baseUrl")
  expect(field).toMatchObject({ default: "${ENDPOINT}/v1" })
})

const FETCH_READY_CASES: { values: FormValues; ready: boolean }[] = [
  { values: {}, ready: false },
  { values: { baseUrl: "", keySource: "none" }, ready: false },
  { values: { baseUrl: "not a URL", keySource: "none" }, ready: false },
  { values: { baseUrl: "ftp://api.example/v1", keySource: "none" }, ready: false },
  { values: { baseUrl: "https://api.example/${ACCOUNT}", keySource: "none" }, ready: false },
  { values: { baseUrl: "https://api.example/${", keySource: "none" }, ready: false },
  { values: { dialect: "unsupported", keySource: "none" }, ready: false },
  { values: { dialect: "", keySource: "none" }, ready: false },
  { values: { keySource: "none" }, ready: true },
  { values: { keySource: "none", baseUrl: " http://localhost:8000/v1/ " }, ready: true },
  { values: { keySource: "auth", apiKey: "" }, ready: false },
  { values: { keySource: "auth", apiKey: "  " }, ready: false },
  { values: { keySource: "auth", apiKey: " typed-key " }, ready: true },
  { values: { keySource: "env", apiKeyEnv: "" }, ready: false },
  { values: { keySource: "env", apiKeyEnv: "UNSET_KEY" }, ready: false },
  { values: { keySource: "env", apiKeyEnv: "ALTERNATE_KEY" }, ready: true },
  { values: { keySource: "env", apiKeyEnv: " ALTERNATE_KEY " }, ready: true },
  { values: { keySource: "env", apiKeyEnv: "1INVALID" }, ready: false },
  { values: { keySource: "env", apiKeyEnv: "BAD-NAME" }, ready: false },
  { values: { keySource: "invalid", apiKey: "typed-key" }, ready: false },
]

test.each(FETCH_READY_CASES)("fetch readiness for partial inputs $values is $ready", ({ values, ready }) => {
  const { admin, seen } = fakeAdmin()
  const envChecks: string[] = []
  admin.envIsSet = (name) => {
    envChecks.push(name)
    return name === "ALTERNATE_KEY" || name === "1INVALID" || name === "BAD-NAME"
  }
  const form = providerFormSpec(admin)
  const input: FormValues = { baseUrl: VENDOR.baseUrl!, ...values }
  // The id is still blank; unrelated invalid fields must not block fetching.
  expect(autoFormActions(form, input)).toEqual(ready ? ["fetchModels"] : [])
  expect(seen).toEqual([])
  expect(envChecks.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toBe(true)
})

test.each([
  ["https://remote.example/v1", true],
  ["http://localhost:8000/v1", true],
  ["http://LOCALHOST:8000/v1", true],
  ["http://127.0.0.1:8000/v1", true],
  ["http://127.42.0.9:8000/v1", true],
  ["http://127.255.255.255:8000/v1", true],
  ["http://[::1]:8000/v1", true],
  ["http://[0:0:0:0:0:0:0:1]:8000/v1", true],
  ["http://remote.example/v1", false],
  ["http://192.168.1.10:8000/v1", false],
  ["http://128.0.0.1:8000/v1", false],
  ["http://localhost.evil.example/v1", false],
  ["http://127.example/v1", false],
  ["http://localhost@remote.example/v1", false],
  ["http://[::2]:8000/v1", false],
])("automatic fetch transport safety for %s is %s", (baseUrl, ready) => {
  const { admin, seen } = fakeAdmin()
  const form = providerFormSpec(admin, undefined, {
    baseUrl: String(baseUrl),
    keySource: "env",
    apiKeyEnv: "ALTERNATE_KEY",
  })
  expect(autoFormActions(form, {})).toEqual(ready ? ["fetchModels"] : [])
  expect(form.fields.find((field) => field.id === "baseUrl")).toMatchObject({
    help: "Remote HTTP sends credentials unencrypted. Use HTTPS or explicitly allow HTTP below.",
  })
  expect(seen).toEqual([])
})

test("fetch readiness uses the draft id's stored key and does not fall back for an unset environment", () => {
  const { admin, seen } = fakeAdmin()
  admin.storedKeyHint = (id) => (id === "stored" ? "…abcd" : undefined)
  const form = providerFormSpec(admin)
  expect(autoFormActions(form, { keySource: "none" })).toEqual([])
  const values = { baseUrl: VENDOR.baseUrl!, keySource: "auth", id: " stored " }
  expect(autoFormActions(form, values)).toEqual(["fetchModels"])
  expect(autoFormActions(form, { ...values, id: "other" })).toEqual([])
  expect(autoFormActions(form, { ...values, keySource: "env", apiKeyEnv: "UNSET_KEY" })).toEqual([])
  expect(seen).toEqual([])
})

test("fetch is automatic on add or initially empty edit, while connection tests stay explicit", () => {
  const { admin, seen } = fakeAdmin()
  admin.storedKeyHint = (id) => (id === "existing" ? "…abcd" : undefined)
  const existing: ProviderDraft = {
    id: "existing",
    dialect: "openai-chat",
    baseUrl: VENDOR.baseUrl!,
    keySource: "auth",
    models: [],
  }
  const forms = [
    providerFormSpec(admin, undefined, { ...existing, models: ["m"] }),
    providerFormSpec(admin, existing),
  ]
  for (const form of forms) {
    const action = form.fields.find((field) => field.id === "fetchModels")
    if (action?.type !== "action") throw new Error("Missing fetch action")
    expect(action.auto?.watch).toEqual([
      "dialect",
      "baseUrl",
      "keySource",
      "apiKey",
      "apiKeyEnv",
      "httpConsent",
      "headers",
      "apiKeyEnvFallbacks",
      { field: "id", when: { keySource: "auth", apiKey: "" } },
    ])
    expect(autoFormActions(form, { apiKey: "typed-key", models: ["picked-later"] })).toEqual(["fetchModels"])
    const schemaAction = toFormSchema(form).fields.find((field) => field.id === "fetchModels")
    expect(schemaAction).toMatchObject({ auto: { watch: action.auto!.watch } })
    expect(form.fields.find((field) => field.id === "testConnection")).not.toHaveProperty("auto")
  }
  const emptyEdit = forms[1]!
  expect(autoFormActions(emptyEdit, {})).toEqual(["fetchModels"])
  const populatedEdit = providerFormSpec(admin, { ...existing, models: ["m"] })
  expect(populatedEdit.fields.find((field) => field.id === "fetchModels")).not.toHaveProperty("auto")
  expect(autoFormActions(populatedEdit, { models: [] })).toEqual([])
  expect(seen.map((draft) => draft.models)).toEqual([["m"], ["m"]])
})

test("fetch results name the provider as list source and models.dev as metadata source", async () => {
  const { admin, seen } = fakeAdmin()
  admin.listModels = async (draft) => {
    seen.push(draft)
    return [
      { id: "known", inCatalog: true },
      { id: "custom", inCatalog: false },
    ]
  }
  const form = providerFormSpec(admin)
  const values = { baseUrl: VENDOR.baseUrl!, keySource: "none" }
  expect(autoFormActions(form, values)).toEqual(["fetchModels"])
  expect(seen).toEqual([])
  const progress: string[] = []
  const result = await runFormAction(form, "fetchModels", values, {
    signal: new AbortController().signal,
    progress: (text) => progress.push(text),
  })
  expect(progress).toEqual(["asking the provider…"])
  expect(result.message).toBe("2 models listed · models.dev details for 1.")
  expect(result.options?.models?.map((option) => option.value)).toEqual(["known", "custom"])
  expect(result.values).toBeUndefined()
  expect(seen).toHaveLength(1)
})

test.each([
  { apiKey: "", expected: undefined },
  { apiKey: "   ", expected: undefined },
  { apiKey: "\t\n", expected: undefined },
  { apiKey: "  typed-key \t", expected: "typed-key" },
])("draft conversion and form actions normalize the auth key $apiKey", async ({ apiKey, expected }) => {
  const { admin, seen } = fakeAdmin()
  admin.storedKeyHint = () => "…abcd"
  const values = {
    id: "existing",
    dialect: "openai-chat",
    baseUrl: VENDOR.baseUrl!,
    keySource: "auth",
    apiKey,
    models: ["m"],
  }
  const draft = draftFromValues(values)
  expect(draft.apiKey).toBe(expected)
  if (expected === undefined) expect(draft).not.toHaveProperty("apiKey")
  const form = providerFormSpec(admin, { ...draft, models: [] })
  expect(autoFormActions(form, values)).toEqual(["fetchModels"])
  for (const action of ["fetchModels", "testConnection"]) {
    await runFormAction(form, action, values, {
      signal: new AbortController().signal,
      progress: () => {},
    })
  }
  expect(seen).toHaveLength(2)
  for (const incoming of seen) {
    expect(incoming.apiKey).toBe(expected)
    if (expected === undefined) expect(incoming).not.toHaveProperty("apiKey")
  }
})

test("draft conversion preserves explicit catalog identity and opt-out", () => {
  expect(draftFromValues({ id: " vendor " }, undefined, "vendor").catalogId).toBe("vendor")
  expect(draftFromValues({ id: "renamed" }, undefined, "vendor").catalogId).toBe("vendor")
  expect(draftFromValues({}, "existing", false).catalogId).toBe(false)
  expect(draftFromValues({ id: "x", catalogId: "not-editable" }).catalogId).toBeUndefined()
})

test("provider form carries catalog identity in descriptions and actions, not editable fields", async () => {
  const { admin, seen } = fakeAdmin()
  const initial = { ...providerVendorInitial(admin, VENDOR), models: ["m"] }
  const form = providerFormSpec(admin, undefined, initial)
  expect(form.fields.some((field) => field.id === "catalogId")).toBe(false)
  expect(form.fields.find((field) => field.id === "models")?.help).toBe(
    "Type to filter · enter adds an unlisted id. Prices are input/output USD per million tokens.",
  )
  const values = { id: "renamed", dialect: "openai-chat", baseUrl: VENDOR.baseUrl!, models: ["m"] }
  for (const id of ["fetchModels", "testConnection"]) {
    const action = form.fields.find((field) => field.id === id)
    if (action?.type !== "action") throw new Error(`Missing action ${id}`)
    await action.run({ values, signal: new AbortController().signal, progress: () => {} })
  }
  expect(seen.map((draft) => draft.catalogId)).toEqual(["vendor", "vendor", "vendor"])
  expect(seen.slice(1).map((draft) => draft.id)).toEqual(["renamed", "renamed"])
})

test("editing an opted-out provider preserves catalog opt-out in descriptions and actions", async () => {
  const { admin, seen } = fakeAdmin()
  const existing: ProviderDraft = {
    id: "vendor",
    catalogId: false,
    dialect: "openai-chat",
    baseUrl: "https://api.vendor.example/v1",
    keySource: "none",
    models: ["m"],
  }
  const form = providerFormSpec(admin, existing)
  const action = form.fields.find((field) => field.id === "testConnection")
  if (action?.type !== "action") throw new Error("Missing connection action")
  await action.run({
    values: { models: ["m"] },
    signal: new AbortController().signal,
    progress: () => {},
  })
  expect(seen.map((draft) => draft.catalogId)).toEqual([false, false])
})

test("model info columns carry limits and catalog prices for initial and fetched options", async () => {
  const { admin } = fakeAdmin()
  const models = [
    {
      id: "known",
      name: "Known model",
      contextWindow: 400000,
      cost: { input: 1.25, output: 10 },
      inCatalog: true,
    },
    { id: "provider-only", contextWindow: 128000, cost: { input: 9, output: 9 }, inCatalog: false },
    { id: "unknown", inCatalog: false },
  ]
  admin.describeModels = () => models
  admin.listModels = async () => models
  const form = providerFormSpec(admin, undefined, { models: models.map((model) => model.id) })
  const expected = [
    { value: "known", label: "known (Known model)", detail: ["400K", "$1.25/$10"] },
    { value: "provider-only", detail: ["128K"] },
    { value: "unknown" },
  ]
  const field = form.fields.find((field) => field.id === "models")
  if (field?.type !== "multiselect") throw new Error("Missing models field")
  expect(field.options).toEqual(expected)
  const result = await runFormAction(
    form,
    "fetchModels",
    { baseUrl: VENDOR.baseUrl! },
    {
      signal: new AbortController().signal,
      progress: () => {},
    },
  )
  expect(result.options?.models).toEqual(expected)
  const schema = toFormSchema(form).fields.find((field) => field.id === "models")
  expect(schema && "options" in schema && schema.options).toEqual(expected)
})

test("a form connection test resolving after cancellation reports cancellation, not failure", async () => {
  const { admin } = fakeAdmin()
  const controller = new AbortController()
  admin.test = async () => {
    controller.abort()
    return { ok: false, latencyMs: 1, message: "Probe resolved unsuccessfully" }
  }
  const result = await runFormAction(
    providerFormSpec(admin),
    "testConnection",
    { models: ["m"], baseUrl: VENDOR.baseUrl! },
    {
      signal: controller.signal,
      progress: () => {},
    },
  )
  expect(result).toEqual({ message: "Cancelled.", tone: "warning" })
})

test("Edit credential guidance keeps the live key instead of implying a disk reload", () => {
  const { admin } = fakeAdmin()
  const existing: ProviderDraft = {
    id: "test",
    dialect: "openai-chat",
    baseUrl: VENDOR.baseUrl!,
    keySource: "auth",
    models: ["m"],
  }
  for (const hint of [undefined, "…disk"]) {
    admin.storedKeyHint = () => hint
    const field = providerFormSpec(admin, existing).fields.find((field) => field.id === "apiKey")
    if (field?.type !== "secret") throw new Error("Missing key field")
    expect(field.placeholder).toContain("keep the current key")
    expect(field.placeholder).not.toContain("keep the stored key")
    expect("default" in field).toBe(false)
  }
})

function actionContext(values: FormValues, signal = new AbortController().signal) {
  return { values, signal, progress: () => {} }
}

const READY_VALUES: FormValues = {
  id: "new-provider",
  dialect: "openai-chat",
  baseUrl: "https://api.example/v1",
  keySource: "none",
  models: ["first", "second"],
}

test("one-page vendor choices use only the cache and keep curated Popular order before All vendors", () => {
  const { admin } = fakeAdmin()
  admin.vendors = async () => {
    throw new Error("must not fetch")
  }
  admin.cachedVendors = () => [
    VENDOR,
    { ...VENDOR, id: "openai", name: "OpenAI", models: ["cached-model"] },
    { ...VENDOR, id: "anthropic", name: "Anthropic" },
    { ...VENDOR, id: "groq", name: "Groq" },
    { ...VENDOR, id: "deepseek", name: "DeepSeek" },
  ]
  const form = providerFormSpec(admin)
  expect(form.fields[0]).toMatchObject({ type: "select", id: "vendor" })
  const field = form.fields[0]
  if (field?.type !== "select") throw new Error("Missing vendor select")
  expect(field.options.map(({ value, group }) => [value, group])).toEqual([
    ["anthropic", "Popular"],
    ["openai", "Popular"],
    ["deepseek", "Popular"],
    ["groq", "Popular"],
    ["vendor", "All vendors"],
    ["__custom__", "All vendors"],
  ])
  expect(field.options.at(-1)?.label).toBe("Custom (choose protocol)")
  expect(form.sections?.find((section) => section.title === "Advanced")).toMatchObject({ collapsed: true })
  const previous = formDefaults(form)
  const result = form.change?.({ ...previous, vendor: "openai" }, previous)
  expect(result?.values).toMatchObject({
    id: "openai",
    dialect: VENDOR.dialect,
    baseUrl: VENDOR.baseUrl,
    keySource: "env",
    apiKeyEnv: "ALTERNATE_KEY",
    models: [],
  })
  expect(result?.options?.models).toEqual([])
})

test("catalog vendor changes refill identity and endpoint but preserve selected models", () => {
  const { admin } = fakeAdmin()
  admin.cachedVendors = () => [
    VENDOR,
    {
      ...VENDOR,
      id: "other",
      dialect: "anthropic-messages",
      baseUrl: "https://other.example",
      models: ["other-model"],
    },
  ]
  const form = providerFormSpec(admin)
  let previous = formDefaults(form)
  const choose = (patch: FormValues) => {
    const values = { ...previous, ...patch }
    const updates = form.change?.(values, previous).values
    previous = { ...values, ...updates }
  }
  choose({ vendor: "vendor" })
  choose({ id: "personal-id", dialect: "anthropic-messages", models: ["custom/model"] })
  choose({ dialect: "openai-chat" })
  choose({ vendor: "other" })
  expect(previous).toMatchObject({
    id: "other",
    dialect: "anthropic-messages",
    models: ["custom/model"],
    baseUrl: "https://other.example",
  })
  expect(draftFromValues(previous).catalogId).toBe("other")
})

test("catalog vendor selection replaces initial endpoint flags but edit IDs cannot be changed", () => {
  const { admin } = fakeAdmin()
  admin.cachedVendors = () => [VENDOR]
  const form = providerFormSpec(admin, undefined, { id: "flag-id", baseUrl: "https://flag.example" })
  const previous = formDefaults(form)
  const result = form.change?.({ ...previous, vendor: "vendor" }, previous)
  expect(result?.values).toMatchObject({ id: "vendor-3", baseUrl: VENDOR.baseUrl })
  const existing = { ...draftFromValues(READY_VALUES), id: "fixed" }
  const editing = providerFormSpec(admin, existing)
  expect(editing.fields.some((field) => field.id === "id")).toBe(false)
  expect(draftFromValues({ ...READY_VALUES, id: "injected" }, existing.id, undefined, existing).id).toBe(
    "fixed",
  )
})

test("advanced headers, fallback variables and fast descriptors round trip without losing unknown model settings", () => {
  const { admin } = fakeAdmin()
  const overrides: Record<string, ModelSettings & { futureSetting: { preserve: boolean } }> = {
    first: { id: "first", contextWindow: 99999, fast: false, futureSetting: { preserve: true } },
  }
  const existing: ProviderDraft = { ...draftFromValues(READY_VALUES), modelOverrides: overrides }
  const form = providerFormSpec(admin, existing)
  const values = {
    ...formDefaults(form),
    headers: "Authorization=Bearer literal-secret\nX-Team=${TEAM}",
    apiKeyEnvFallbacks: "KEY_A, KEY_B",
    modelFast:
      '{"first":{"kind":"service-tier","value":"priority","textOnly":true,"responseHeader":"x-tier"}}',
    compat_maxTokensField: "max_completion_tokens",
    compat_streamUsage: "false",
  }
  const checked = checkForm(form, values)
  expect(checked.errors).toEqual({})
  const draft = draftFromValues(checked.values, existing.id, existing.catalogId, existing)
  expect(draft.headers).toEqual({ Authorization: "Bearer literal-secret", "X-Team": "${TEAM}" })
  expect(draft.apiKeyEnvFallbacks).toEqual(["KEY_A", "KEY_B"])
  expect(draft.compat).toEqual({ maxTokensField: "max_completion_tokens", streamUsage: false })
  expect(draft.modelOverrides?.first).toMatchObject({
    contextWindow: 99999,
    futureSetting: { preserve: true },
    fast: { kind: "service-tier", value: "priority", textOnly: true, responseHeader: "x-tier" },
  })
  const cleared = draftFromValues({ ...checked.values, modelFast: "{}" }, existing.id, undefined, existing)
  expect(cleared.modelOverrides?.first).not.toHaveProperty("fast")
  expect(cleared.modelOverrides?.first).toHaveProperty("futureSetting")
  expect(existing.modelOverrides?.first?.fast).toBe(false)
})

test.each([
  '{"m":true}',
  '{"m":{"kind":"service-tier"}}',
  '{"m":{"kind":"anthropic-speed","value":"priority"}}',
  '{"m":{"kind":"service-tier","value":"priority","extra":true}}',
  '{"m":{"kind":"service-tier","value":"priority","textOnly":"yes"}}',
  "[false]",
  "null",
  "{",
])("invalid fast descriptor %s fails validation without breaking live changes", (modelFast) => {
  const { admin } = fakeAdmin()
  const form = providerFormSpec(admin)
  const previous = formDefaults(form)
  expect(checkForm(form, { ...READY_VALUES, modelFast }).errors).toHaveProperty("modelFast")
  expect(() => form.change?.({ ...previous, modelFast }, previous)).not.toThrow()
  expect(autoFormActions(form, { ...READY_VALUES, modelFast })).toEqual([])
})

test("compatibility controls preserve unrendered and unrelated options and can clear rendered compat", () => {
  const { admin } = fakeAdmin()
  const existing: ProviderDraft = {
    ...draftFromValues(READY_VALUES),
    compat: { maxTokensField: "max_completion_tokens", streamUsage: false, webSearch: true },
  }
  const form = providerFormSpec(admin, existing)
  const unchanged = checkForm(form, formDefaults(form)).values
  expect(draftFromValues(unchanged, existing.id, undefined, existing).compat).toEqual(existing.compat)
  const values = checkForm(form, { ...formDefaults(form), dialect: "anthropic-messages" }).values
  expect(values).not.toHaveProperty("compat_streamUsage")
  expect(values).not.toHaveProperty("compat_maxTokensField")
  expect(values).toHaveProperty("compat_thinking")
  expect(draftFromValues(values, existing.id, undefined, existing).compat).toEqual(existing.compat)
  const cleared = draftFromValues({ ...values, compat_webSearch: "" }, existing.id, undefined, existing)
  expect(cleared.compat).toEqual({ maxTokensField: "max_completion_tokens", streamUsage: false })
})

test("live preview uses persistence preview and masks keys, literal headers, and URL credentials", () => {
  const { admin } = fakeAdmin()
  let previewed: ProviderDraft | undefined
  admin.preview = (draft) => {
    previewed = draft
    return {
      dialect: draft.dialect,
      baseUrl: "https://user:password@api.example/v1?api_key=query-secret",
      headers: { Authorization: "Bearer header-secret", "X-Env": "${HEADER_KEY}" },
      models: [{ id: "first", contextWindow: 12345 }],
    }
  }
  const form = providerFormSpec(admin)
  const preview =
    form.preview?.({ ...READY_VALUES, keySource: "auth", apiKey: "auth-secret" }).join("\n") ?? ""
  expect(previewed?.apiKey).toBe("auth-secret")
  for (const secret of ["auth-secret", "password", "query-secret", "header-secret"])
    expect(preview).not.toContain(secret)
  expect(preview).toContain("${HEADER_KEY}")
  expect(preview).toContain("12345")
  expect(preview).toContain("key → auth.json: new-provider →")
  expect(preview).toContain("new key")
})

test("manual and automatic remote HTTP fetching requires explicit consent, and fetched options retain custom IDs", async () => {
  const { admin } = fakeAdmin()
  const calls: ProviderDraft[] = []
  admin.listModels = async (draft) => {
    calls.push(draft)
    return [{ id: "listed", inCatalog: false }]
  }
  const form = providerFormSpec(admin)
  const values = { ...READY_VALUES, baseUrl: "http://remote.example/v1", models: ["custom"] }
  expect(autoFormActions(form, values)).toEqual([])
  expect((await runFormAction(form, "fetchModels", values, actionContext(values))).tone).toBe("error")
  expect(calls).toEqual([])
  expect(autoFormActions(form, { ...values, httpConsent: true })).toEqual(["fetchModels"])
  const allowed = { ...values, httpConsent: true }
  const result = await runFormAction(form, "fetchModels", allowed, actionContext(allowed))
  expect(calls).toHaveLength(1)
  expect(result.options?.models?.map((option) => option.value)).toEqual(["listed", "custom"])
  expect(result.values).toBeUndefined()
})

test.each([undefined, { input: 1, output: 2 }, { input: 0, output: 0 }])(
  "only explicit Test probes the first model, regardless of price %j",
  async (cost) => {
    const { admin } = fakeAdmin()
    let calls = 0
    admin.describeModels = (_, ids) => ids.map((id) => ({ id, inCatalog: !!cost, ...(cost ? { cost } : {}) }))
    admin.test = async (_, model) => {
      calls++
      expect(model).toBe("first")
      return { ok: true, latencyMs: 1, message: "OK" }
    }
    const form = providerFormSpec(admin)
    expect(form.beforeSubmit).toBeUndefined()
    expect(form.fields.some(({ id }) => id === "testConsent" || id === "saveAnyway")).toBe(false)
    expect(calls).toBe(0)
    expect(
      (await runFormAction(form, "testConnection", READY_VALUES, actionContext(READY_VALUES))).tone,
    ).toBe("success")
    expect(calls).toBe(1)
  },
)

test("failed explicit tests do not gate saving and empty-model tests send no requests", async () => {
  const { admin } = fakeAdmin()
  let calls = 0
  admin.test = async () => {
    calls++
    return { ok: false, latencyMs: 1, message: "failure" }
  }
  const form = providerFormSpec(admin)
  const result = await runFormAction(form, "testConnection", READY_VALUES, actionContext(READY_VALUES))
  expect(result).toMatchObject({ tone: "error" })
  expect(result.message).not.toContain("Save anyway")
  expect(result.values).toBeUndefined()
  expect(form.beforeSubmit).toBeUndefined()
  expect(checkForm(form, READY_VALUES).errors).toEqual({})
  const empty = { ...READY_VALUES, models: [] }
  expect((await runFormAction(form, "testConnection", empty, actionContext(empty))).tone).toBe("warning")
  expect(calls).toBe(1)
})

test("incomplete persistence previews stay safe and malformed endpoints never start model requests", async () => {
  const { admin } = fakeAdmin()
  admin.preview = () => {
    throw new Error("unsafe raw diagnostic")
  }
  let calls = 0
  admin.listModels = async () => {
    calls++
    return []
  }
  const form = providerFormSpec(admin)
  expect(form.preview?.({})).toEqual(["Complete valid provider details to preview settings."])
  expect(
    (
      await runFormAction(
        form,
        "fetchModels",
        { ...READY_VALUES, baseUrl: "ftp://remote.example" },
        actionContext({}),
      )
    ).tone,
  ).toBe("error")
  expect(calls).toBe(0)
})

test("automatic fetch can use a configured fallback environment variable", () => {
  const { admin } = fakeAdmin()
  const form = providerFormSpec(admin)
  expect(
    autoFormActions(form, {
      ...READY_VALUES,
      keySource: "env",
      apiKeyEnv: "UNSET_KEY",
      apiKeyEnvFallbacks: "ALTERNATE_KEY",
    }),
  ).toEqual(["fetchModels"])
})

test("Provider and API key fields stay in their own contiguous sections", () => {
  const { admin } = fakeAdmin()
  const fields = providerFormSpec(admin).fields
  expect(fields.slice(0, 9).map(({ id, section }) => [id, section])).toEqual([
    ["vendor", "Provider"],
    ["id", "Provider"],
    ["dialect", "Provider"],
    ["baseUrl", "Provider"],
    ["httpConsent", "Provider"],
    ["keySource", "API key"],
    ["apiKey", "API key"],
    ["apiKeyEnv", "API key"],
    ["fetchModels", "Models"],
  ])
})

test("dialog-normalized hidden key fields do not count as edits during vendor changes", () => {
  const { admin } = fakeAdmin()
  admin.cachedVendors = () => [VENDOR]
  const form = providerFormSpec(admin)
  const previous = formDefaults(form)
  const values = checkForm(form, { ...previous, vendor: VENDOR.id }).values
  expect(values).not.toHaveProperty("apiKeyEnv")
  const result = runFormChange(form, values, previous)
  expect(result.values).toMatchObject({ keySource: "env", apiKeyEnv: "ALTERNATE_KEY" })
  const populated = { ...previous, ...values, ...result.values }
  const switchAuth = { ...populated, keySource: "auth" }
  runFormChange(form, checkForm(form, switchAuth).values, populated)
  const custom = runFormChange(
    form,
    checkForm(form, { ...switchAuth, vendor: "__custom__" }).values,
    switchAuth,
  )
  expect(custom.values).toHaveProperty("apiKeyEnv", "")
})

test("only relevant request changes revoke HTTP consent", () => {
  const { admin } = fakeAdmin()
  const form = providerFormSpec(admin)
  const previous = { ...formDefaults(form), ...READY_VALUES, httpConsent: true }
  const unrelated = {
    ...previous,
    contextWindow: 12345,
    maxOutput: 1000,
    thinking: true,
    models: ["first", "different-second"],
    modelFast: '{"first":false}',
    apiKeyEnv: "HIDDEN_UNUSED_KEY",
  }
  expect(runFormChange(form, unrelated, previous).values).not.toHaveProperty("httpConsent")
  expect(runFormChange(form, { ...unrelated, models: ["other"] }, unrelated).values).not.toHaveProperty(
    "httpConsent",
  )
  expect(runFormChange(form, { ...unrelated, headers: "X-Test=value" }, unrelated).values).toMatchObject({
    httpConsent: false,
  })
})

test("HTTP consent appears only for unencrypted remote endpoints and also gates explicit tests", async () => {
  const { admin } = fakeAdmin()
  let calls = 0
  admin.test = async () => {
    calls++
    return { ok: true, latencyMs: 1, message: "OK" }
  }
  const form = providerFormSpec(admin)
  const field = form.fields.find((field) => field.id === "httpConsent")!
  expect(isFieldVisible(form, field, READY_VALUES)).toBe(false)
  expect(isFieldVisible(form, field, { ...READY_VALUES, baseUrl: "http://127.0.0.1:8080" })).toBe(false)
  const remote = { ...READY_VALUES, baseUrl: "http://remote.test" }
  expect(isFieldVisible(form, field, remote)).toBe(true)
  expect((await runFormAction(form, "testConnection", remote, actionContext(remote))).tone).toBe("error")
  expect(calls).toBe(0)
  const allowed = { ...remote, httpConsent: true }
  expect((await runFormAction(form, "testConnection", allowed, actionContext(allowed))).tone).toBe("success")
  expect(calls).toBe(1)
})

test.each([false, "other"])("selecting the provider's own vendor replaces prior identity %j", (catalogId) => {
  const { admin } = fakeAdmin()
  admin.cachedVendors = () => [VENDOR]
  const existing = { ...draftFromValues(READY_VALUES), id: VENDOR.id, catalogId }
  const form = providerFormSpec(admin, existing)
  const previous = formDefaults(form)
  const values = { ...previous, vendor: VENDOR.id }
  const updates = runFormChange(form, values, previous).values
  expect(draftFromValues({ ...values, ...updates }, existing.id, catalogId, existing).catalogId).toBe(
    VENDOR.id,
  )
})

test("revealing an untouched environment name does not pin it across vendor changes", () => {
  const { admin } = fakeAdmin()
  admin.envIsSet = () => false
  admin.cachedVendors = () => [VENDOR, { ...VENDOR, id: "other", env: ["OTHER_KEY"] }]
  const form = providerFormSpec(admin)
  let previous = formDefaults(form)
  const change = (patch: FormValues) => {
    const values = { ...previous, ...patch }
    previous = { ...values, ...runFormChange(form, values, previous).values }
  }
  change({ vendor: VENDOR.id })
  expect(previous).toMatchObject({ keySource: "auth", apiKeyEnv: "VENDOR_API_KEY" })
  change({ keySource: "env" })
  change({ vendor: "other" })
  expect(previous.apiKeyEnv).toBe("OTHER_KEY")
  change({ apiKeyEnv: "PERSONAL_KEY" })
  change({ vendor: VENDOR.id })
  expect(previous.apiKeyEnv).toBe("PERSONAL_KEY")
})

test("fallback-only credentials can be entered through the actual dialog flow", async () => {
  const { admin } = fakeAdmin()
  const form = providerFormSpec(admin, undefined, {
    id: "fallback-only",
    baseUrl: "https://api.example/v1",
    keySource: "env",
  })
  const questions: string[] = []
  let primaryQuestions = 0
  const values = await runFormDialogs(form, {
    select: async (title, options) => {
      questions.push(title)
      if (title.startsWith("Advanced:")) return "Yes"
      if (title.includes("Fetch models?") || title.startsWith("Defaults for")) return "No"
      if (title.includes(" · Models")) return "Done"
      return options[0]
    },
    input: async (title, opts) => {
      questions.push(title)
      if (title.includes(" · Environment variable")) {
        // A repeat means the user cannot reach Advanced; cancel instead of looping forever.
        return ++primaryQuestions === 1 ? "" : undefined
      }
      if (title.includes(" · Fallback key environment variables")) return "ALTERNATE_KEY"
      return opts?.initial ?? ""
    },
  })
  expect(primaryQuestions).toBe(1)
  expect(questions.some((title) => title.startsWith("Advanced:"))).toBe(true)
  expect(values).toMatchObject({ keySource: "env", apiKeyEnv: "", apiKeyEnvFallbacks: "ALTERNATE_KEY" })
  expect(checkForm(form, { ...values, apiKeyEnvFallbacks: "" }).errors).toHaveProperty("apiKeyEnvFallbacks")
  expect(checkForm(form, { ...values, apiKeyEnv: "BAD-NAME" }).errors).toHaveProperty("apiKeyEnv")
})

test.each([true, false])(
  "preview recursively masks legacy apiKey with persistence preview %j",
  (persisted) => {
    const { admin } = fakeAdmin()
    const overrides = {
      first: { id: "first", apiKey: "legacy-model-secret", future: [{ apiKey: "nested-secret", keep: 7 }] },
    }
    const entry = {
      apiKey: "legacy-provider-secret",
      dialect: "openai-chat",
      models: Object.values(overrides),
      future: { apiKey: "future-secret", keep: true },
    }
    if (persisted) admin.preview = () => entry
    const existing = { ...draftFromValues(READY_VALUES), modelOverrides: overrides }
    const form = providerFormSpec(admin, existing)
    const preview = form.preview?.(formDefaults(form)).join("\n") ?? ""
    for (const secret of ["legacy-provider-secret", "legacy-model-secret", "nested-secret", "future-secret"])
      expect(preview).not.toContain(secret)
    expect(preview).toContain('"keep": 7')
    expect(existing.modelOverrides?.first).toEqual(overrides.first)
    expect(entry.apiKey).toBe("legacy-provider-secret")
  },
)

test.each([false, true])(
  "explicit pending tests share requests with independent cancellation %j",
  async (cancel) => {
    const { admin } = fakeAdmin()
    const gate = Promise.withResolvers<void>()
    let calls = 0
    let requestSignal: AbortSignal | undefined
    admin.test = async (_draft, _model, signal) => {
      calls++
      requestSignal = signal
      await gate.promise
      return { ok: true, latencyMs: 1, message: "OK" }
    }
    const form = providerFormSpec(admin)
    const controller = new AbortController()
    const first = runFormAction(
      form,
      "testConnection",
      READY_VALUES,
      actionContext(READY_VALUES, controller.signal),
    )
    const second = runFormAction(form, "testConnection", READY_VALUES, actionContext(READY_VALUES))
    if (cancel) {
      controller.abort()
      expect((await first).tone).toBe("warning")
    }
    expect(calls).toBe(1)
    expect(requestSignal?.aborted).toBe(false)
    gate.resolve()
    expect((await first).tone).toBe(cancel ? "warning" : "success")
    expect((await second).tone).toBe("success")
  },
)

test("a late explicit test stays stale even after returning to its original inputs", async () => {
  const { admin } = fakeAdmin()
  const gate = Promise.withResolvers<void>()
  admin.test = async () => {
    await gate.promise
    return { ok: true, latencyMs: 1, message: "OK" }
  }
  const form = providerFormSpec(admin)
  const pending = runFormAction(form, "testConnection", READY_VALUES, actionContext(READY_VALUES))
  const changed = { ...READY_VALUES, baseUrl: "https://changed.example" }
  runFormChange(form, changed, READY_VALUES)
  runFormChange(form, READY_VALUES, changed)
  gate.resolve()
  expect(await pending).toMatchObject({ tone: "error", message: expect.stringContaining("Inputs changed") })
  expect((await runFormAction(form, "testConnection", READY_VALUES, actionContext(READY_VALUES))).tone).toBe(
    "success",
  )
})

test("cancelling an explicit test aborts the request and a later test starts fresh", async () => {
  const { admin } = fakeAdmin()
  const gate = Promise.withResolvers<void>()
  let calls = 0
  let requestSignal: AbortSignal | undefined
  admin.test = async (_draft, _model, signal) => {
    calls++
    requestSignal = signal
    if (calls === 1) await gate.promise
    return { ok: true, latencyMs: 1, message: "OK" }
  }
  const form = providerFormSpec(admin)
  const controller = new AbortController()
  const pending = runFormAction(
    form,
    "testConnection",
    READY_VALUES,
    actionContext(READY_VALUES, controller.signal),
  )
  controller.abort()
  expect((await pending).tone).toBe("warning")
  expect(requestSignal?.aborted).toBe(true)
  gate.resolve()
  expect((await runFormAction(form, "testConnection", READY_VALUES, actionContext(READY_VALUES))).tone).toBe(
    "success",
  )
  expect(calls).toBe(2)
})

test("catalog presets never preselect catalog models", () => {
  const { admin } = fakeAdmin()
  const vendor = { ...VENDOR, models: ["catalog-one", "catalog-two"] }
  admin.cachedVendors = () => [vendor]
  const initial = providerVendorInitial(admin, vendor)
  expect(initial).not.toHaveProperty("models")
  const form = providerFormSpec(admin, undefined, initial)
  expect(formDefaults(form).models).toEqual([])
})

test.each([false, true])(
  "preview omits empty settings and false defaults with persistence preview %j",
  (persisted) => {
    const { admin } = fakeAdmin()
    if (persisted)
      admin.preview = () => ({
        dialect: "openai-chat",
        baseUrl: "https://api.example/v1",
        catalogId: false,
        apiKeyEnv: "",
        apiKeyEnvFallbacks: [],
        headers: {},
        compat: {},
        models: [],
        defaultModel: { caps: { thinking: false, images: false, promptCache: false } },
      })
    const form = providerFormSpec(admin)
    const preview = form.preview?.({ ...READY_VALUES, models: [], keySource: "auth", apiKey: "secret" }) ?? []
    const json = JSON.parse(preview[1]!)
    expect(json).toEqual({
      providers: { "new-provider": { dialect: "openai-chat", baseUrl: "https://api.example/v1" } },
    })
    expect(preview.at(-1)).toBe("key → auth.json: new-provider → •••• (new key)")
  },
)

test("preview keeps meaningful false overrides and never mutates persisted settings", () => {
  const { admin } = fakeAdmin()
  const entry: ProviderSettings & { models: Array<ModelSettings & { empty: never[]; blank: string }> } = {
    dialect: "openai-chat",
    compat: { streamUsage: false },
    models: [{ id: "first", fast: false, caps: { images: false }, empty: [], blank: "" }],
  }
  admin.preview = () => entry
  const form = providerFormSpec(admin)
  const preview = JSON.parse(form.preview?.(READY_VALUES)[1] ?? "{}")
  expect(preview.providers["new-provider"]).toEqual({
    dialect: "openai-chat",
    compat: { streamUsage: false },
    models: [{ id: "first", fast: false, caps: { images: false } }],
  })
  expect(entry.models[0]).toHaveProperty("empty", [])
  expect(entry.models[0]).toHaveProperty("blank", "")
})
