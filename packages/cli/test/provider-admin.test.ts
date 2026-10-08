// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Catalog URL placeholders are literal fixtures.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createCatalog } from "@amira/ai"
import type { ProviderDraft } from "@amira/api"
import { createProviderAdmin, keyHint, modelNote } from "../src/provider-admin.ts"

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "amira-admin-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const KEY = "sk-live-abcdefgh12345678"
const catalog = createCatalog({
  deepseek: {
    models: {
      "deepseek-chat": {
        limit: { context: 128000, output: 8192 },
        cost: { input: 0.27, output: 1.1 },
        tool_call: true,
      },
      "catalog-only": { limit: { context: 64000 } },
    },
  },
  other: { models: { "deepseek-chat": {} } },
})

function setup(env: Record<string, string> = {}) {
  const seen: { url: string; auth?: string }[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>
    seen.push({ url, ...(h.authorization ? { auth: h.authorization } : {}) })
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "deepseek-chat" }, { id: "deepseek-new" }] })
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  }) as unknown as typeof globalThis.fetch
  const ai = createAi({ catalog, env, fetch })
  const restricted: string[] = []
  let current = "anthropic"
  const admin = createProviderAdmin({
    ai,
    home,
    env,
    fetch,
    currentProvider: () => current,
    restrict: async (file) => {
      restricted.push(file)
      return undefined
    },
  })
  return { admin, ai, seen, restricted, setCurrent: (p: string) => (current = p) }
}

const draft = (over: Partial<ProviderDraft> = {}): ProviderDraft => ({
  id: "ds-test",
  dialect: "openai-chat",
  baseUrl: "https://api.deepseek.com",
  keySource: "auth",
  apiKey: KEY,
  models: ["deepseek-chat", "deepseek-new"],
  defaults: { contextWindow: 64000, thinking: true, images: false, promptCache: false },
  ...over,
})

const settings = () => JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))
const auth = () => JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8"))

test("fetching models uses the typed key and says what the catalog knows", async () => {
  const { admin, seen } = setup()
  const models = await admin.listModels(draft())
  expect(seen[0]).toEqual({ url: "https://api.deepseek.com/models", auth: `Bearer ${KEY}` })
  expect(models).toEqual([
    {
      id: "deepseek-chat",
      contextWindow: 128000,
      maxOutput: 8192,
      cost: { input: 0.27, output: 1.1 },
      inCatalog: true,
    },
    { id: "deepseek-new", inCatalog: false },
  ])
  expect(models.map(modelNote)).toEqual([
    "deepseek-chat (128k context, $0.27/$1.1 per M)",
    "deepseek-new (not in the catalog: the defaults apply)",
  ])
})

test("saving writes settings and auth.json, and the provider works at once", async () => {
  const { admin, ai, restricted } = setup()
  const out = await admin.save(draft())
  expect(out).not.toContain(KEY)
  expect(out).toContain(keyHint(KEY))
  expect(out).toContain("Switch to it with /model ds-test/deepseek-chat.")
  expect(out).toContain("Model details from deepseek (metadata only; model list unchanged).")
  expect(settings().providers["ds-test"]).toEqual({
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-chat" }, { id: "deepseek-new" }],
    // The catalog knows these models under deepseek, whose name is in the base URL.
    catalogId: "deepseek",
    defaultModel: { contextWindow: 64000, caps: { thinking: true } },
  })
  expect(auth()).toEqual({ "ds-test": { type: "api_key", apiKey: KEY } })
  expect(restricted).toEqual([path.join(home, "auth.json")])
  expect(ai.hasKey("ds-test")).toBe(true)
  expect(ai.knownModels()).toEqual(["ds-test/deepseek-chat", "ds-test/deepseek-new"])
  expect(admin.describeModels(draft(), ["deepseek-chat"])).toEqual([
    {
      id: "deepseek-chat",
      contextWindow: 128000,
      maxOutput: 8192,
      cost: { input: 0.27, output: 1.1 },
      inCatalog: true,
    },
  ])
  expect(ai.model("ds-test/deepseek-chat").contextWindow).toBe(128000)
  expect(ai.model("ds-test/deepseek-new").contextWindow).toBe(64000)
  expect(admin.storedKeyHint("ds-test")).toBe("…5678")
})

test.each(["deepseek", "deepseek-anthropic"])(
  "%s uses its own catalog, not borrowed metadata",
  async (id) => {
    const { admin, ai } = setup()
    const out = await admin.save(draft({ id }))
    expect(out).not.toContain("Model details from")
    expect(ai.knownModels()).toContain(`${id}/catalog-only`)
  },
)

test("a saved provider the session starts using, or the one in use, needs no /model", async () => {
  const saved: [string, string[]][] = []
  const ai = createAi({ catalog, env: {} })
  let current: string | undefined
  const admin = createProviderAdmin({
    ai,
    home,
    env: {},
    currentProvider: () => current,
    restrict: async () => undefined,
    onSaved: (id, models) => {
      saved.push([id, models])
      return `${id}/${models[0]}`
    },
  })
  const first = await admin.save(draft())
  expect(saved).toEqual([["ds-test", ["deepseek-chat", "deepseek-new"]]])
  expect(first).toContain("Now using ds-test/deepseek-chat.")
  expect(first).not.toContain("/model ds-test")
  current = "ds-test"
  const edited = await admin.save(draft({ models: ["deepseek-new"] }))
  expect(edited).toContain("In use: the changes apply now (ds-test/deepseek-new).")
  expect(edited).toContain("Model details from deepseek (metadata only; model list unchanged).")
  expect(ai.knownModels()).toEqual(["ds-test/deepseek-new"])
  expect(edited).not.toContain("run /model again")
})

test("editing keeps what the form does not show, and an empty key keeps the stored one", async () => {
  const { admin, seen } = setup()
  await admin.save(draft())
  const file = path.join(home, "settings.json")
  const s = settings()
  s.providers["ds-test"].headers = { "x-team": "a" }
  s.providers["ds-test"].models[0].maxOutput = 4000
  writeFileSync(file, JSON.stringify(s))
  const d = setup().admin.draft("ds-test")
  // A fresh admin reads the settings through its own ai, which does not know the provider yet.
  expect(d).toBeUndefined()
  const current = admin.draft("ds-test")!
  expect(current).toMatchObject({ keySource: "auth", models: ["deepseek-chat", "deepseek-new"] })
  expect("apiKey" in current).toBe(false)
  await admin.save({
    ...current,
    apiKey: "",
    models: ["deepseek-chat"],
    baseUrl: "https://api.deepseek.com/v1",
  })
  expect(settings().providers["ds-test"]).toMatchObject({
    baseUrl: "https://api.deepseek.com/v1",
    headers: { "x-team": "a" },
    models: [{ id: "deepseek-chat", maxOutput: 4000 }],
  })
  expect(auth()["ds-test"].apiKey).toBe(KEY)
  // Probes of the edited draft use the stored key.
  await admin.test({ ...current, apiKey: "" }, "deepseek-chat")
  expect(seen.at(-1)).toEqual({ url: "https://api.deepseek.com/chat/completions", auth: `Bearer ${KEY}` })
})

test("an environment variable instead of a stored key", async () => {
  const { admin, ai, seen } = setup({ MY_DS_KEY: "sk-from-env-000000" })
  const out = await admin.save(draft({ keySource: "env", apiKeyEnv: "MY_DS_KEY", apiKey: "" }))
  expect(out).toContain("Key: read from $MY_DS_KEY (set).")
  expect(settings().providers["ds-test"].apiKeyEnv).toBe("MY_DS_KEY")
  expect(() => readFileSync(path.join(home, "auth.json"))).toThrow()
  expect(ai.hasKey("ds-test")).toBe(true)
  const r = await admin.test(admin.draft("ds-test")!, "deepseek-chat")
  expect(r.ok).toBe(true)
  expect(seen.at(-1)?.auth).toBe("Bearer sk-from-env-000000")
  await expect(admin.save(draft({ keySource: "env", apiKeyEnv: "bad name" }))).rejects.toThrow(
    "environment variable",
  )
  await expect(admin.save(draft({ id: "Bad!" }))).rejects.toThrow("lower-case")
  await expect(admin.save(draft({ baseUrl: "ftp://x" }))).rejects.toThrow("http or https")
  await expect(admin.save(draft({ dialect: "nope" }))).rejects.toThrow("unknown dialect")
})

test("removing refuses the provider in use, then drops the entry and, if asked, the key", async () => {
  const { admin, ai, setCurrent } = setup()
  await admin.save(draft())
  setCurrent("ds-test")
  await expect(admin.remove("ds-test", { removeKey: true })).rejects.toThrow("is in use")
  setCurrent("anthropic")
  const out = await admin.remove("ds-test", { removeKey: true })
  expect(out).toContain('Removed provider "ds-test"')
  expect(out).toContain("Deleted its key")
  expect(settings().providers).toEqual({})
  expect(auth()).toEqual({})
  expect(ai.providers().some((p) => p.id === "ds-test")).toBe(false)
  await expect(admin.remove("ds-test", { removeKey: false })).rejects.toThrow("is not in")
  // Nothing is built in: a provider settings do not have is simply not there.
  await expect(admin.remove("openai", { removeKey: false })).rejects.toThrow(
    `provider "openai" is not in ${path.join(home, "settings.json")}`,
  )
})

test("a new key replaces the stored one and is used at once", async () => {
  const { admin, ai, seen } = setup()
  await admin.save(draft())
  const out = await admin.setKey("ds-test", "sk-new-key-99998888")
  expect(out).toContain("…8888")
  expect(out).not.toContain("sk-new")
  expect(auth()["ds-test"].apiKey).toBe("sk-new-key-99998888")
  const reply = ai.stream({
    model: ai.model("ds-test/deepseek-chat"),
    systemPrompt: "",
    messages: [],
    tools: [],
  })
  for await (const _ of reply) {
    // Drain.
  }
  expect(seen.at(-1)?.auth).toBe("Bearer sk-new-key-99998888")
  await expect(admin.setKey("nope", "k")).rejects.toThrow("unknown provider")
})

test("a deleted or replaced stored key stops being used at once, and auth.json is made private again", async () => {
  const { admin, ai, restricted, setCurrent } = setup()
  setCurrent("ds-test")
  // A provider the session has that is not in the user settings (e.g. from a project file).
  ai.registerProvider({ id: "keyed", dialect: "openai-chat", baseUrl: "http://k", apiKeyEnv: "KEYED_KEY" })
  await admin.setKey("keyed", "sk-keyed-stored-11112222")
  expect(ai.hasKey("keyed")).toBe(true)
  restricted.length = 0
  // Nothing in settings, but its stored key can go.
  await admin.remove("keyed", { removeKey: true })
  expect(restricted).toEqual([path.join(home, "auth.json")])
  expect(ai.hasKey("keyed")).toBe(false)
  // Former built-in ids are ordinary ids now: one may go without a key.
  expect(await admin.save(draft({ id: "openai", keySource: "none" }))).not.toContain("built in")
  expect(settings().providers.openai.apiKeyEnv).toBeUndefined()
  // Switching a provider to an unset variable does not fall back to its old stored key.
  await admin.save(draft())
  await admin.save(draft({ keySource: "env", apiKeyEnv: "UNSET_VAR", apiKey: "" }))
  expect(ai.hasKey("ds-test")).toBe(false)
})

test("vendor metadata refreshes a legacy catalog once, with the existing timeout", async () => {
  const ai = createAi({ catalog, env: {} })
  let calls = 0
  let loading = 0
  let signal: AbortSignal | undefined
  const admin = createProviderAdmin({
    ai,
    home,
    env: {},
    catalog: {
      fetch: (async (_url: unknown, init?: RequestInit) => {
        expect(loading).toBe(1)
        calls++
        signal = init?.signal ?? undefined
        return Response.json({
          deepseek: {
            id: "deepseek",
            name: "DeepSeek",
            env: ["DEEPSEEK_API_KEY"],
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.deepseek.com/",
            models: {},
          },
          unsupported: {
            id: "unsupported",
            name: "Unsupported",
            env: [],
            npm: "@other/sdk",
            api: "https://other.example",
            models: {},
          },
          missing: {
            id: "missing",
            name: "Missing endpoint",
            env: [],
            npm: "@ai-sdk/openai-compatible",
            models: {},
          },
        })
      }) as typeof fetch,
    },
  })
  const request = { onLoading: () => loading++ }
  const vendors = await admin.vendors!(request)
  expect(vendors).toEqual([
    {
      id: "deepseek",
      name: "DeepSeek",
      env: ["DEEPSEEK_API_KEY"],
      dialect: "openai-chat",
      baseUrl: "https://api.deepseek.com",
    },
    { id: "missing", name: "Missing endpoint", env: [] },
    { id: "unsupported", name: "Unsupported", env: [] },
  ])
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(await admin.vendors!(request)).toEqual(vendors)
  expect(calls).toBe(1)
  expect(loading).toBe(1)
  expect(ai.catalog?.()?.vendor?.("deepseek")?.env).toEqual(["DEEPSEEK_API_KEY"])
})

test("failed vendor refresh is attempted once and keeps legacy model facts", async () => {
  const ai = createAi({ catalog, env: {} })
  let calls = 0
  let loading = 0
  const admin = createProviderAdmin({
    ai,
    home,
    env: {},
    catalog: {
      fetch: (async () => {
        calls++
        throw new Error("offline")
      }) as unknown as typeof fetch,
    },
  })
  const request = { onLoading: () => loading++ }
  expect(await admin.vendors!(request)).toEqual([])
  expect(await admin.vendors!(request)).toEqual([])
  expect(calls).toBe(1)
  expect(loading).toBe(1)
  expect(ai.catalog?.()?.find("deepseek", "deepseek-chat")?.contextWindow).toBe(128000)
})

test("explicit catalog identity survives renaming and empty model lists", async () => {
  const { admin, ai } = setup()
  await admin.save(
    draft({ id: "renamed", catalogId: "deepseek", models: [], baseUrl: "https://proxy.example" }),
  )
  expect(settings().providers.renamed.catalogId).toBe("deepseek")
  expect(admin.draft("renamed")?.catalogId).toBe("deepseek")
  expect(ai.model("renamed/deepseek-chat").contextWindow).toBe(128000)
  await admin.save(draft({ id: "deepseek", catalogId: "deepseek", models: [] }))
  expect(settings().providers.deepseek.catalogId).toBeUndefined()
  await admin.save(draft({ id: "local", catalogId: false, models: ["deepseek-chat"] }))
  expect(settings().providers.local.catalogId).toBe(false)
  expect(admin.describeModels(admin.draft("local")!, ["deepseek-chat"])[0]?.inCatalog).toBe(false)
})

test("cached vendor fields skip the loading status and preserve unsupported placeholders", async () => {
  const ai = createAi({
    env: {},
    catalog: createCatalog({
      unsupported: {
        id: "unsupported",
        name: "Unsupported",
        env: [],
        npm: "@other/sdk",
        api: "${ENDPOINT}/v1",
        models: {},
      },
    }),
  })
  let loading = 0
  const admin = createProviderAdmin({
    ai,
    home,
    env: {},
    catalog: {
      fetch: (async () => {
        throw new Error("must not fetch a populated vendor catalog")
      }) as unknown as typeof fetch,
    },
  })
  expect(await admin.vendors!({ onLoading: () => loading++ })).toEqual([
    { id: "unsupported", name: "Unsupported", env: [], baseUrl: "${ENDPOINT}/v1" },
  ])
  expect(loading).toBe(0)
})

test.each([
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
  "${NEON_AI_GATEWAY_BASE_URL}/v1",
  "https://api.example/${UNCLOSED",
])("saving and probing reject unresolved URL placeholders: %s", async (baseUrl) => {
  const { admin, seen } = setup()
  const d = draft({ baseUrl })
  await expect(admin.save(d)).rejects.toThrow("in the base URL with its value")
  await expect(admin.listModels(d)).rejects.toThrow("in the base URL with its value")
  await expect(admin.test(d, "tiny")).rejects.toThrow("in the base URL with its value")
  expect(seen).toEqual([])
  expect(() => settings()).toThrow()
  expect(() => auth()).toThrow()
})
