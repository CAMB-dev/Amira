import { expect, test } from "bun:test"
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
