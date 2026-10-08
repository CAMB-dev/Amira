// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Catalog URL placeholders are literal fixtures.
import { expect, test } from "bun:test"
import {
  autoFormActions,
  checkForm,
  type FormValues,
  formDefaults,
  runFormAction,
  toFormSchema,
} from "../src/form.ts"
import {
  draftFromValues,
  providerFormSpec,
  providerVendorInitial,
  providerVendorLabel,
} from "../src/provider-form.ts"
import type { ProviderAdmin, ProviderDraft, ProviderVendor } from "../src/providers.ts"

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
    help: "Non-loopback HTTP would send the key unencrypted. Use Fetch models manually.",
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
  expect(progress).toEqual([`asking ${VENDOR.baseUrl}…`])
  expect(result.message).toBe(
    "The provider listed 2 models; models.dev adds context window and price for 1. Pick them in the list below.",
  )
  expect(result.options?.models?.map((option) => option.value)).toEqual(["known", "custom"])
  expect(seen).toHaveLength(1)
})

test("draft conversion stores only distinct catalog ids and preserves explicit opt-out", () => {
  expect(draftFromValues({ id: " vendor " }, undefined, "vendor").catalogId).toBeUndefined()
  expect(draftFromValues({ id: "renamed" }, undefined, "vendor").catalogId).toBe("vendor")
  expect(draftFromValues({}, "existing", false).catalogId).toBe(false)
  expect(draftFromValues({ id: "x", catalogId: "not-editable" }).catalogId).toBeUndefined()
})

test("provider form carries catalog identity in descriptions and actions, not editable fields", async () => {
  const { admin, seen } = fakeAdmin()
  const initial = { ...providerVendorInitial(admin, VENDOR), models: ["m"] }
  const form = providerFormSpec(admin, undefined, initial)
  expect(form.fields.some((field) => field.id === "catalogId")).toBe(false)
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
