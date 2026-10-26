// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Catalog URL placeholders are literal fixtures.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createCatalog } from "@amira/ai"
import {
  draftFromValues,
  formDefaults,
  type ModelSettings,
  type ProviderDraft,
  providerFormSpec,
} from "@amira/api"
import { authFile, loadAuth, loadSettings, providersFromSettings } from "@amira/core"
import pkg from "../package.json" with { type: "json" }
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

function setup(env: Record<string, string | undefined> = {}) {
  const seen: { url: string; auth?: string }[] = []
  const userAgents: (string | null)[] = []
  const requests: { headers: Headers; body?: Record<string, unknown> }[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>
    const headers = new Headers(init.headers)
    userAgents.push(headers.get("user-agent"))
    requests.push({
      headers,
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}),
    })
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
  return {
    admin,
    ai,
    fetch,
    seen,
    userAgents,
    requests,
    restricted,
    setCurrent: (p: string) => (current = p),
  }
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

test("provider probes and model lists identify Amira with the CLI version", async () => {
  const { admin, userAgents } = setup()
  await admin.listModels(draft())
  expect((await admin.test(draft(), "deepseek-chat")).ok).toBe(true)
  expect(userAgents).toEqual([`Amira/${pkg.version}`, `Amira/${pkg.version}`])
})

test.each(["literal", "environment"])(
  "custom authorization diagnostics never expose %s header secrets",
  async (source) => {
    const token = "fake-custom-auth-secret-123456789"
    const env = { TOKEN: token }
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization")!
      expect(authorization).toBe(`Bearer ${token}`)
      return Response.json(
        { error: { message: `rejected ${authorization}; token ${token}` } },
        { status: 401 },
      )
    }) as typeof globalThis.fetch
    const admin = createProviderAdmin({ ai: createAi({ env }), home, env, fetch })
    const d = draft({
      keySource: "none",
      apiKey: undefined,
      headers: { Authorization: source === "literal" ? `Bearer ${token}` : "Bearer ${TOKEN}" },
    })
    const error = await admin.listModels(d).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).not.toContain(token)
    expect(message).not.toContain("no key was sent")
    expect(message).toContain("HTTP 401")
    expect(message).toContain("rejected")
    const result = await admin.test(d, "deepseek-chat")
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain(token)
    expect(result.message).not.toContain("no key was sent")
    expect(result.message).toContain("HTTP 401")
    expect(result.message).toContain("rejected")
  },
)

test.each(["throw", "403", "500", "stream"])(
  "custom header diagnostics discard transport and provider echoes: %s",
  async (failure) => {
    const token = "fake-bearer-secret-123456789"
    const custom = "fake-custom-header-secret-987654321"
    const seen: Headers[] = []
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      const message = `echo ${custom}; ${token}; ${token.slice(0, 8)}...${token.slice(-6)}`
      if (failure === "throw") throw new Error(message)
      if (failure === "stream" && !String(_url).endsWith("/models")) {
        return new Response(`data: ${JSON.stringify({ error: { message } })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({ error: { message } }, { status: failure === "stream" ? 401 : Number(failure) })
    }) as typeof globalThis.fetch
    const env = { TOKEN: token, CUSTOM: custom }
    const admin = createProviderAdmin({ ai: createAi({ env }), home, env, fetch })
    const d = draft({
      keySource: "none",
      apiKey: undefined,
      headers: { authorization: "Bearer ${TOKEN}", "x-custom-secret": "${CUSTOM}" },
    })
    const error = await admin.listModels(d).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    const result = await admin.test(d, "deepseek-chat")
    expect(result.ok).toBe(false)
    for (const message of [(error as Error).message, result.message]) {
      for (const secret of [token, custom, token.slice(0, 8), token.slice(-6)]) {
        expect(message).not.toContain(secret)
      }
      expect(message).not.toContain("no key was sent")
    }
    expect(seen).toHaveLength(2)
    expect(seen[0]!.get("x-custom-secret")).toBe(custom)
    expect(seen[1]!.get("authorization")).toBe(`Bearer ${token}`)
  },
)

test("model-list authentication errors still explain when no credential was sent", async () => {
  const fetch = (async () =>
    Response.json(
      { error: { message: "unauthorized" } },
      { status: 401 },
    )) as unknown as typeof globalThis.fetch
  const admin = createProviderAdmin({ ai: createAi({ env: {} }), home, env: {}, fetch })
  await expect(admin.listModels(draft({ keySource: "none", apiKey: undefined }))).rejects.toThrow(
    "no key was sent: enter one first",
  )
})

test("fetching models uses the typed key and says what the catalog knows", async () => {
  const { admin, seen } = setup()
  const models = await admin.listModels(draft())
  expect(seen[0]).toEqual({ url: "https://api.deepseek.com/models", auth: `Bearer ${KEY}` })
  expect(models).toEqual([
    {
      id: "deepseek-chat",
      contextWindow: 128000,
      contextWindowSource: "catalog",
      maxOutput: 8192,
      cost: { input: 0.27, output: 1.1 },
      inCatalog: true,
    },
    {
      id: "deepseek-new",
      contextWindow: 64000,
      contextWindowSource: "settings",
      maxOutput: 8192,
      inCatalog: false,
    },
  ])
  expect(models.map(modelNote)).toEqual([
    "deepseek-chat (128k context, $0.27/$1.1 per M)",
    "deepseek-new (64k context)",
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
    keySource: "auth",
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
      contextWindowSource: "catalog",
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

test("testing an environment provider after Set key uses the same live credential as streaming", async () => {
  const { admin, ai, seen } = setup({ MY_DS_KEY: "sk-from-env-000000" })
  await admin.save(draft({ keySource: "env", apiKeyEnv: "MY_DS_KEY", apiKey: "" }))
  await admin.setKey("ds-test", "sk-new-key-99998888")
  const current = admin.draft("ds-test")!
  expect("apiKey" in current).toBe(false)
  expect(JSON.stringify(current)).not.toContain("sk-")
  const reply = ai.stream({
    model: ai.model("ds-test/deepseek-chat"),
    systemPrompt: "",
    messages: [],
    tools: [],
  })
  for await (const _ of reply) {
    // Drain.
  }
  expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
  expect(seen.map((request) => request.auth)).toEqual([
    "Bearer sk-new-key-99998888",
    "Bearer sk-new-key-99998888",
  ])
  expect(current.keySource).toBe("auth")
})

test("configured environment fallbacks take precedence over stored keys in drafts and probes", async () => {
  const { admin, ai, seen } = setup({ FALLBACK_KEY: "sk-fallback-000000" })
  ai.registerProvider({
    id: "ds-test",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "PRIMARY_KEY",
    apiKeyEnvFallbacks: ["UNSET_KEY", "FALLBACK_KEY"],
  })
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "ds-test": { apiKey: KEY } }))
  ai.setStoredKey?.("ds-test", KEY)
  const current = admin.draft("ds-test")!
  const reply = ai.stream({
    model: ai.model("ds-test/deepseek-chat"),
    systemPrompt: "",
    messages: [],
    tools: [],
  })
  for await (const _ of reply) {
    // Drain.
  }
  expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
  expect(seen.map((request) => request.auth)).toEqual([
    "Bearer sk-fallback-000000",
    "Bearer sk-fallback-000000",
  ])
  expect(current.keySource).toBe("env")
  expect("apiKey" in current).toBe(false)
})

test("unsaved credential edits override the live key without changing the configured provider", async () => {
  const { admin, ai, seen } = setup({
    MY_DS_KEY: "sk-from-env-000000",
    OTHER_KEY: "sk-other-env-000000",
    FALLBACK_KEY: "sk-fallback-000000",
  })
  await admin.save(draft({ keySource: "env", apiKeyEnv: "MY_DS_KEY", apiKey: "" }))
  await admin.setKey("ds-test", KEY)
  const configured = ai.providers().find((p) => p.id === "ds-test")!
  // A session-only key can differ from auth.json; the public draft must not disclose it.
  ai.registerProvider({ ...configured, apiKey: "sk-session-000000", apiKeyEnvFallbacks: ["FALLBACK_KEY"] })
  const current = admin.draft("ds-test")!
  expect(current.keySource).toBe("auth")
  expect("apiKey" in current).toBe(false)
  expect(JSON.stringify(current)).not.toContain("sk-")
  const saved = settings()
  const cases: { edit: Partial<ProviderDraft>; auth?: string }[] = [
    { edit: {}, auth: "Bearer sk-session-000000" },
    { edit: { apiKey: "" }, auth: "Bearer sk-session-000000" },
    { edit: { apiKey: "sk-typed-000000" }, auth: "Bearer sk-typed-000000" },
    { edit: { keySource: "env", apiKey: "sk-ignored-000000" }, auth: "Bearer sk-from-env-000000" },
    { edit: { keySource: "env", apiKeyEnv: "OTHER_KEY" }, auth: "Bearer sk-other-env-000000" },
    {
      edit: { keySource: "env", apiKeyEnv: "UNSET_KEY" },
      auth: "Bearer sk-fallback-000000",
    },
    { edit: { keySource: "env", apiKeyEnv: "UNSET_KEY", apiKeyEnvFallbacks: [] } },
    { edit: { keySource: "none", apiKey: "sk-ignored-000000" } },
  ]
  for (const { edit, auth: expected } of cases) {
    const edited = { ...current, baseUrl: "https://unsaved.example/v1", ...edit }
    expect((await admin.test(edited, "deepseek-chat")).ok).toBe(true)
    expect(seen.at(-1)?.auth).toBe(expected)
    expect(seen.at(-1)?.url).toBe("https://unsaved.example/v1/chat/completions")
    await admin.listModels(edited)
    expect(seen.at(-1)?.auth).toBe(expected)
  }
  expect(settings()).toEqual(saved)
  expect(auth()["ds-test"].apiKey).toBe(KEY)
  expect(ai.providers().find((p) => p.id === "ds-test")?.apiKey).toBe("sk-session-000000")
})

test.each([
  {
    name: "primary environment",
    env: { PRIMARY_KEY: "sk-primary-000000" },
    stored: KEY,
    apiKey: undefined,
    expected: "sk-primary-000000",
    keySource: "env",
  },
  {
    name: "stored after empty variables",
    env: { PRIMARY_KEY: "", FALLBACK_KEY: "" },
    stored: KEY,
    apiKey: undefined,
    expected: KEY,
    keySource: "auth",
  },
  {
    name: "explicit empty live key",
    env: { PRIMARY_KEY: "sk-primary-000000" },
    stored: KEY,
    apiKey: "",
    expected: undefined,
    keySource: "auth",
  },
  {
    name: "no key needed",
    env: {},
    stored: undefined,
    apiKey: undefined,
    expected: undefined,
    keySource: "none",
  },
])("configured credential precedence: $name", async ({ env, stored, apiKey, expected, keySource }) => {
  const { admin, ai, seen } = setup(env)
  ai.registerProvider({
    id: "ds-test",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    ...(keySource !== "none" && apiKey !== ""
      ? { apiKeyEnv: "PRIMARY_KEY", apiKeyEnvFallbacks: ["FALLBACK_KEY"] }
      : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  })
  if (stored) {
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "ds-test": { apiKey: stored } }))
    ai.setStoredKey?.("ds-test", stored)
  }
  const current = admin.draft("ds-test")!
  expect(current.keySource).toBe(keySource)
  expect("apiKey" in current).toBe(false)
  const reply = ai.stream({
    model: ai.model("ds-test/deepseek-chat"),
    systemPrompt: "",
    messages: [],
    tools: [],
  })
  for await (const _ of reply) {
    // Drain.
  }
  expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
  expect(seen.map((request) => request.auth)).toEqual([
    expected ? `Bearer ${expected}` : undefined,
    expected ? `Bearer ${expected}` : undefined,
  ])
})

test("an environment draft uses variable fallbacks, but only a fresh auth draft uses the stored key", async () => {
  const env = { PRIMARY_KEY: "sk-primary-000000", FALLBACK_KEY: "sk-fallback-000000" }
  const { admin, ai, seen } = setup(env)
  ai.registerProvider({
    id: "ds-test",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "PRIMARY_KEY",
    apiKeyEnvFallbacks: ["FALLBACK_KEY"],
  })
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "ds-test": { apiKey: KEY } }))
  ai.setStoredKey?.("ds-test", KEY)
  const current = admin.draft("ds-test")!
  expect(current.keySource).toBe("env")
  env.PRIMARY_KEY = ""
  expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
  expect(seen.at(-1)?.auth).toBe("Bearer sk-fallback-000000")
  env.FALLBACK_KEY = ""
  expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
  expect(seen.at(-1)?.auth).toBeUndefined()
  const refreshed = admin.draft("ds-test")!
  expect(refreshed.keySource).toBe("auth")
  expect((await admin.test(refreshed, "deepseek-chat")).ok).toBe(true)
  expect(seen.at(-1)?.auth).toBe(`Bearer ${KEY}`)
})

test("a deleted or replaced stored key stops being used at once, and auth.json is made private again", async () => {
  const { admin, ai, seen, restricted, setCurrent } = setup()
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
  const current = admin.draft("ds-test")!
  expect(current.keySource).toBe("env")
  expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
  expect(seen.at(-1)?.auth).toBeUndefined()
  // An unsaved switch back to auth can still deliberately select the retained key.
  expect((await admin.test({ ...current, keySource: "auth" }, "deepseek-chat")).ok).toBe(true)
  expect(seen.at(-1)?.auth).toBe(`Bearer ${KEY}`)
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
      models: [],
      dialect: "openai-chat",
      baseUrl: "https://api.deepseek.com",
    },
    { id: "missing", name: "Missing endpoint", env: [], models: [] },
    { id: "unsupported", name: "Unsupported", env: [], models: [] },
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
    { id: "unsupported", name: "Unsupported", env: [], models: [], baseUrl: "${ENDPOINT}/v1" },
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

test("saving No key never reactivates a retained auth key in a configured probe", async () => {
  const { admin, ai, seen } = setup()
  await admin.save(draft())
  await admin.save({ ...admin.draft("ds-test")!, keySource: "none", baseUrl: "https://new.example/v1" })
  for await (const _ of ai.stream({
    model: ai.model("ds-test/deepseek-chat"),
    systemPrompt: "",
    messages: [],
    tools: [],
  })) {
  }
  expect(seen.at(-1)?.auth).toBeUndefined()
  expect(auth()["ds-test"].apiKey).toBe(KEY)
  const current = admin.draft("ds-test")!
  expect(current.keySource).toBe("none")
  expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
  expect(seen.at(-1)?.auth).toBeUndefined()
})

test("an explicit same-name switch to an unset environment variable cannot borrow auth.json", async () => {
  const { admin, ai, seen } = setup()
  ai.registerProvider({
    id: "ds-test",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "PRIMARY_KEY",
  })
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "ds-test": { apiKey: KEY } }))
  ai.setStoredKey?.("ds-test", KEY)
  const current = admin.draft("ds-test")!
  expect(current.keySource).toBe("auth")
  await admin.test(current, "deepseek-chat")
  expect(seen.at(-1)?.auth).toBe(`Bearer ${KEY}`)
  await admin.test({ ...current, keySource: "env" }, "deepseek-chat")
  expect(seen.at(-1)?.auth).toBeUndefined()
})

test.each(["replace", "delete"])(
  "configured probes keep Ai's in-memory stored key when auth.json changes: %s",
  async (change) => {
    const { admin, ai, seen } = setup()
    ai.registerProvider({ id: "ds-test", dialect: "openai-chat", baseUrl: "https://api.deepseek.com" })
    ai.setStoredKey?.("ds-test", KEY)
    const file = path.join(home, "auth.json")
    writeFileSync(file, JSON.stringify({ "ds-test": { apiKey: KEY } }))
    const current = admin.draft("ds-test")!
    if (change === "replace")
      writeFileSync(file, JSON.stringify({ "ds-test": { apiKey: "sk-other-instance-99999999" } }))
    else rmSync(file)
    for await (const _ of ai.stream({
      model: ai.model("ds-test/deepseek-chat"),
      systemPrompt: "",
      messages: [],
      tools: [],
    })) {
    }
    expect((await admin.test(current, "deepseek-chat")).ok).toBe(true)
    await admin.listModels(current)
    expect(seen.map((request) => request.auth)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${KEY}`])
    expect(admin.draft("ds-test")?.keySource).toBe("auth")
    expect("apiKey" in current).toBe(false)
    expect(JSON.stringify(current)).not.toContain(KEY)
  },
)

test("whitespace-only probe and save keys behave like an empty key", async () => {
  const { admin, ai, seen, restricted } = setup()
  await admin.save(draft())
  const current = admin.draft("ds-test")!
  const before = readFileSync(path.join(home, "auth.json"), "utf8")
  restricted.length = 0
  expect((await admin.test({ ...current, apiKey: " \t\n " }, "deepseek-chat")).ok).toBe(true)
  expect(seen.at(-1)?.auth).toBe(`Bearer ${KEY}`)
  await admin.save({ ...current, apiKey: " \t\n " })
  expect(readFileSync(path.join(home, "auth.json"), "utf8")).toBe(before)
  expect(restricted).toEqual([])
  for await (const _ of ai.stream({
    model: ai.model("ds-test/deepseek-chat"),
    systemPrompt: "",
    messages: [],
    tools: [],
  })) {
  }
  expect(seen.at(-1)?.auth).toBe(`Bearer ${KEY}`)
})

test.each(["replace", "delete", "session-only"])(
  "blank-key saves preserve the live credential despite disk state: %s",
  async (change) => {
    const { admin, ai, seen } = setup()
    ai.registerProvider({
      id: "ds-test",
      dialect: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      ...(change === "session-only" ? { apiKey: KEY } : {}),
    })
    if (change !== "session-only") ai.setStoredKey?.("ds-test", KEY)
    const file = path.join(home, "auth.json")
    if (change === "replace") writeFileSync(file, JSON.stringify({ "ds-test": { apiKey: "local-new" } }))
    const current = admin.draft("ds-test")!
    await admin.test({ ...current, apiKey: "   " }, "deepseek-chat")
    expect(seen.at(-1)?.auth).toBe(`Bearer ${KEY}`)
    await admin.save({ ...current, apiKey: "   " })
    for await (const _ of ai.stream({
      model: ai.model("ds-test/deepseek-chat"),
      systemPrompt: "",
      messages: [],
      tools: [],
    })) {
    }
    expect(seen.at(-1)?.auth).toBe(`Bearer ${KEY}`)
  },
)

test("independent draft overrides and source discovery work without the optional source query", async () => {
  const { ai } = setup()
  ai.registerProvider({
    id: "ds-test",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKey: KEY,
    apiKeyEnv: "PRIMARY_KEY",
  })
  const { credentialSource: _source, ...withoutSource } = ai
  const seen: (string | null)[] = []
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"))
    if (String(_url).endsWith("/models")) return Response.json({ data: [{ id: "m" }] })
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof globalThis.fetch
  const admin = createProviderAdmin({
    ai: withoutSource,
    home,
    env: { OTHER_KEY: "fake-independent-env" },
    fetch,
  })
  expect(admin.draft("ds-test")?.keySource).toBe("auth")
  const changed = { ...admin.draft("ds-test")!, keySource: "env" as const, apiKeyEnv: "OTHER_KEY" }
  await admin.listModels(changed)
  expect((await admin.test(changed, "m")).ok).toBe(true)
  expect(seen).toEqual(["Bearer fake-independent-env", "Bearer fake-independent-env"])
})

test("blank-key saves cannot reactivate a stored fallback blocked by an empty explicit key", async () => {
  const { admin, ai, seen } = setup()
  ai.registerProvider({
    id: "ds-test",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
  })
  ai.setStoredKey?.("ds-test", KEY)
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "ds-test": { apiKey: KEY } }))
  const current = admin.draft("ds-test")!
  await admin.test({ ...current, apiKey: "   " }, "deepseek-chat")
  expect(seen.at(-1)?.auth).toBeUndefined()
  await admin.save({ ...current, apiKey: "   " })
  for await (const _ of ai.stream({
    model: ai.model("ds-test/deepseek-chat"),
    systemPrompt: "",
    messages: [],
    tools: [],
  })) {
  }
  expect(seen.at(-1)?.auth).toBeUndefined()
  expect(auth()["ds-test"].apiKey).toBe(KEY)
})

test.each([undefined, ""])(
  "configured fallback-only variables use the live credential without a primary name: %s",
  async (apiKeyEnv) => {
    const { admin, ai, seen } = setup({ ALT_KEY: KEY })
    ai.registerProvider({
      id: "ds-test",
      dialect: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnvFallbacks: ["ALT_KEY"],
    })
    const current = admin.draft("ds-test")!
    expect(current.keySource).toBe("env")
    expect(current.apiKeyEnv).toBeUndefined()
    for await (const _ of ai.stream({
      model: ai.model("ds-test/deepseek-chat"),
      systemPrompt: "",
      messages: [],
      tools: [],
    })) {
    }
    const tested = { ...current, apiKeyEnv }
    expect((await admin.test(tested, "deepseek-chat")).ok).toBe(true)
    await admin.listModels(tested)
    expect(seen.map((request) => request.auth)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${KEY}`])
  },
)

test("preview omits legacy inline API keys recursively without changing persisted settings", async () => {
  const { admin } = setup()
  await admin.save(draft())
  const file = path.join(home, "settings.json")
  const raw = settings()
  const legacyKey = "legacy-inline-secret-123456789"
  raw.providers["ds-test"].apiKey = legacyKey
  raw.providers["ds-test"].future = {
    apiKey: legacyKey,
    enabled: true,
    nested: [{ apiKey: legacyKey, name: "keep" }],
  }
  raw.providers["ds-test"].models[0].future = { apiKey: legacyKey, enabled: true }
  writeFileSync(file, JSON.stringify(raw))
  const before = readFileSync(file, "utf8")
  const current = admin.draft("ds-test")!
  const preview = admin.preview!(current)
  expect(JSON.stringify(preview)).not.toContain(legacyKey)
  expect(preview).not.toHaveProperty("apiKey")
  expect(preview).toMatchObject({
    future: { enabled: true, nested: [{ name: "keep" }] },
    models: [{ id: "deepseek-chat", future: { enabled: true } }, { id: "deepseek-new" }],
  })
  expect(readFileSync(file, "utf8")).toBe(before)
  await admin.save(current)
  expect(settings()).toEqual(raw)
  expect(auth()["ds-test"].apiKey).toBe(KEY)
})

test("advanced drafts roundtrip through preview and save without exposing the key", async () => {
  const { admin, ai } = setup({ FALLBACK_KEY: "fake-env-key" })
  const overrides: Record<string, ModelSettings> = {
    "deepseek-chat": {
      maxOutput: 4000,
      thinking: "high",
      tools: { edit: "apply_patch" },
      caps: { images: true, parallelToolCalls: false },
      fast: { kind: "service-tier", value: "priority", textOnly: true, responseHeader: "x-tier" },
      cost: { input: 1, output: 2, fast: { input: 3, output: 4 } },
    },
    "deepseek-new": { fast: false, contextWindow: 12000 },
  }
  await admin.save(
    draft({
      apiKeyEnvFallbacks: ["FALLBACK_KEY"],
      headers: { "x-team": "team", authorization: "Bearer ${TOKEN}" },
      compat: { maxTokensField: "max_completion_tokens", streamUsage: false, compaction: "off" },
      modelOverrides: overrides,
    }),
  )
  const raw = settings()
  raw.providers["ds-test"].future = { enabled: true }
  raw.providers["ds-test"].models[0].future = { mode: "keep" }
  raw.providers["ds-test"].models[0].caps.future = "keep"
  writeFileSync(path.join(home, "settings.json"), JSON.stringify(raw))
  const current = admin.draft("ds-test")!
  expect(current).toMatchObject({
    headers: { "x-team": "team", authorization: "Bearer ${TOKEN}" },
    apiKeyEnvFallbacks: ["FALLBACK_KEY"],
    compat: { maxTokensField: "max_completion_tokens", streamUsage: false, compaction: "off" },
    modelOverrides: overrides,
  })
  expect(current).not.toHaveProperty("apiKey")
  expect(JSON.stringify(current)).not.toContain(KEY)
  const edited = {
    ...current,
    apiKey: "",
    headers: { "x-team": "edited" },
    compat: { streamUsage: true },
    modelOverrides: { "deepseek-chat": { fast: false, caps: { thinking: true } } },
  } satisfies ProviderDraft
  const preview = admin.preview!(edited)
  expect(settings()).toEqual(raw)
  expect(preview).toMatchObject({
    future: { enabled: true },
    headers: { "x-team": "edited" },
    compat: { streamUsage: true },
    models: [
      {
        id: "deepseek-chat",
        maxOutput: 4000,
        fast: false,
        caps: { images: true, thinking: true, future: "keep" },
        future: { mode: "keep" },
      },
      { id: "deepseek-new", fast: false, contextWindow: 12000 },
    ],
  })
  expect(preview).not.toHaveProperty("apiKey")
  await admin.save(edited)
  expect(settings().providers["ds-test"]).toEqual(preview)
  expect(auth()["ds-test"].apiKey).toBe(KEY)
  expect(ai.model("ds-test/deepseek-chat")).toMatchObject({ fast: false, maxOutput: 4000 })
})

test.each(["auth", "none"] as const)(
  "omitted advanced fields preserve settings when switching to %s",
  async (keySource) => {
    const { admin, ai, seen } = setup({ ALT_KEY: "fake-alt-key" })
    await admin.save(
      draft({
        keySource: "env",
        apiKeyEnv: "PRIMARY_KEY",
        apiKeyEnvFallbacks: ["ALT_KEY"],
        headers: { "x-team": "keep" },
        compat: { streamUsage: false },
        modelOverrides: { "deepseek-chat": { fast: false, maxOutput: 5000 } },
      }),
    )
    const d = draft({ keySource, apiKey: keySource === "auth" ? KEY : undefined, defaults: undefined })
    const preview = admin.preview!(d)
    await admin.save(d)
    expect(settings().providers["ds-test"]).toEqual(preview)
    expect(preview).toMatchObject({
      apiKeyEnvFallbacks: ["ALT_KEY"],
      headers: { "x-team": "keep" },
      compat: { streamUsage: false },
      defaultModel: { contextWindow: 64000 },
      models: [{ id: "deepseek-chat", fast: false, maxOutput: 5000 }, { id: "deepseek-new" }],
    })
    expect(preview).not.toHaveProperty("apiKeyEnv")
    const current = admin.draft("ds-test")!
    expect(current.keySource).toBe(keySource)
    for await (const _ of ai.stream({
      model: ai.model("ds-test/deepseek-chat"),
      systemPrompt: "",
      messages: [],
      tools: [],
    })) {
    }
    await admin.test(current, "deepseek-chat")
    expect(seen.map((request) => request.auth)).toEqual(
      keySource === "auth" ? [`Bearer ${KEY}`, `Bearer ${KEY}`] : [undefined, undefined],
    )
  },
)

test.each(["auth", "none"] as const)(
  "retained environment fallbacks stay inactive after saving %s and restarting",
  async (keySource) => {
    const env = { ALT_KEY: "fake-env-key" }
    const { admin, ai, fetch, seen } = setup(env)
    await admin.save(draft())
    await admin.save(draft({ keySource: "env", apiKeyEnv: "PRIMARY_KEY", apiKeyEnvFallbacks: ["ALT_KEY"] }))
    await admin.save({ ...admin.draft("ds-test")!, keySource })
    const loaded = loadSettings({ cwd: home, home })
    expect(loaded.warnings).toEqual([])
    const restarted = createAi({
      providers: providersFromSettings(loaded.settings.providers),
      apiKeys: loadAuth(authFile(home)).keys,
      env,
      fetch,
    })
    for (const instance of [ai, restarted]) {
      for await (const _ of instance.stream({
        model: instance.model("ds-test/deepseek-chat"),
        systemPrompt: "",
        messages: [],
        tools: [],
      })) {
      }
    }
    expect(seen.map((request) => request.auth)).toEqual(
      keySource === "auth" ? [`Bearer ${KEY}`, `Bearer ${KEY}`] : [undefined, undefined],
    )
    expect(settings().providers["ds-test"].apiKeyEnvFallbacks).toEqual(["ALT_KEY"])
    expect(settings().providers["ds-test"]).not.toHaveProperty("apiKey")
    expect(createProviderAdmin({ ai: restarted, home, env }).draft("ds-test")?.keySource).toBe(keySource)
  },
)

test("switching back to environment credentials persists the explicit environment selection", async () => {
  const env = { ALT_KEY: "fake-env-key" }
  const { admin } = setup(env)
  await admin.save(draft({ apiKeyEnvFallbacks: ["ALT_KEY"] }))
  expect(settings().providers["ds-test"].keySource).toBe("auth")
  await admin.save({ ...admin.draft("ds-test")!, keySource: "env" })
  const loaded = loadSettings({ cwd: home, home })
  expect(loaded.settings.providers?.["ds-test"]?.keySource).toBe("env")
  expect(settings().providers["ds-test"].apiKeyEnvFallbacks).toEqual(["ALT_KEY"])
  const restarted = createAi({
    providers: providersFromSettings(loaded.settings.providers),
    apiKeys: loadAuth(authFile(home)).keys,
    env,
  })
  expect(restarted.providerEndpoint("ds-test").apiKey).toBe("fake-env-key")
  env.ALT_KEY = ""
  expect(restarted.providerEndpoint("ds-test").apiKey).toBeUndefined()
  expect(auth()["ds-test"].apiKey).toBe(KEY)
})

test.each(["auth", "none"] as const)(
  "clearing retained fallbacks keeps the explicit %s key source setting",
  async (keySource) => {
    const { admin } = setup()
    await admin.save(draft({ keySource, apiKeyEnvFallbacks: ["ALT_KEY"] }))
    expect(settings().providers["ds-test"].keySource).toBe(keySource)
    await admin.save({ ...admin.draft("ds-test")!, apiKeyEnvFallbacks: [] })
    expect(settings().providers["ds-test"].apiKeyEnvFallbacks).toEqual([])
    expect(settings().providers["ds-test"].keySource).toBe(keySource)
  },
)

test("an explicitly saved environment selection survives reload without a fallback field", async () => {
  const env = { PRIMARY_KEY: "fake-environment-key" }
  const { admin, fetch } = setup(env)
  await admin.save(draft({ keySource: "env", apiKey: undefined, apiKeyEnv: "PRIMARY_KEY" }))
  expect(settings().providers["ds-test"].keySource).toBe("env")
  expect(settings().providers["ds-test"]).not.toHaveProperty("apiKeyEnvFallbacks")
  const reloaded = createAi({ providers: providersFromSettings(settings().providers), env, fetch })
  expect(reloaded.credentialSource?.("ds-test")).toBe("env")
  expect(createProviderAdmin({ ai: reloaded, home, env }).draft("ds-test")?.keySource).toBe("env")
})

test("setting a key reactivates a provider saved with No key", async () => {
  const { admin, ai } = setup({ ALT_KEY: "fake-env-key" })
  await admin.save(draft({ keySource: "none", apiKeyEnvFallbacks: ["ALT_KEY"] }))
  await admin.setKey("ds-test", KEY)
  expect(ai.providerEndpoint("ds-test").apiKey).toBe(KEY)
  const loaded = loadSettings({ cwd: home, home })
  const restarted = createAi({
    providers: providersFromSettings(loaded.settings.providers),
    apiKeys: loadAuth(authFile(home)).keys,
    env: { ALT_KEY: "fake-env-key" },
  })
  expect(restarted.providerEndpoint("ds-test").apiKey).toBe(KEY)
  expect(settings().providers["ds-test"].keySource).toBe("auth")
})

test("probe headers and compatibility use unsaved edits and expand environment values only for the request", async () => {
  const { admin, requests, ai } = setup({ TOKEN: "fake-header-secret", EMPTY: "" })
  await admin.save(draft({ headers: { "x-old": "old" }, compat: { streamUsage: true } }))
  const current = admin.draft("ds-test")!
  const edited = {
    ...current,
    headers: {
      authorization: "Bearer ${TOKEN}",
      "x-default": "${EMPTY:-default}",
      "x-missing": "before${MISSING}after",
      "x-malformed": "${UNCLOSED",
    },
    compat: { maxTokensField: "max_completion_tokens", streamUsage: false },
  } satisfies ProviderDraft
  await admin.listModels(edited)
  expect((await admin.test(edited, "deepseek-chat")).ok).toBe(true)
  for (const { headers } of requests) {
    expect(headers.get("authorization")).toBe("Bearer fake-header-secret")
    expect(headers.get("x-default")).toBe("default")
    expect(headers.get("x-missing")).toBe("beforeafter")
    expect(headers.get("x-malformed")).toBe("${UNCLOSED")
    expect(headers.has("x-old")).toBe(false)
  }
  expect(requests[1]!.body).toHaveProperty("max_completion_tokens")
  expect(requests[1]!.body).not.toHaveProperty("max_tokens")
  expect(requests[1]!.body).not.toHaveProperty("stream_options")
  expect(edited.headers.authorization).toBe("Bearer ${TOKEN}")
  expect(settings().providers["ds-test"].headers).toEqual({ "x-old": "old" })
  expect(ai.providers().find((p) => p.id === "ds-test")?.headers).toEqual({ "x-old": "old" })
  await admin.listModels({ ...edited, headers: {} })
  expect(requests.at(-1)!.headers.has("x-old")).toBe(false)
  expect(requests.at(-1)!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
})

test("unsaved fallback edits use the draft order even when the primary variable is unchanged", async () => {
  const { admin, seen } = setup({ OLD_KEY: "fake-old", NEW_KEY: " fake-new " })
  await admin.save(draft({ keySource: "env", apiKeyEnv: "PRIMARY_KEY", apiKeyEnvFallbacks: ["OLD_KEY"] }))
  const current = admin.draft("ds-test")!
  await admin.listModels({ ...current, apiKeyEnvFallbacks: ["MISSING", "NEW_KEY", "OLD_KEY"] })
  expect(seen.at(-1)?.auth).toBe("Bearer fake-new")
  await admin.test({ ...current, apiKeyEnvFallbacks: [] }, "deepseek-chat")
  expect(seen.at(-1)?.auth).toBeUndefined()
  expect(settings().providers["ds-test"].apiKeyEnvFallbacks).toEqual(["OLD_KEY"])
  const onlyFallback = { ...current, apiKeyEnv: undefined, apiKeyEnvFallbacks: ["NEW_KEY"] }
  expect(admin.preview!(onlyFallback)).not.toHaveProperty("apiKeyEnv")
  await admin.save(onlyFallback)
  expect(settings().providers["ds-test"].apiKeyEnvFallbacks).toEqual(["NEW_KEY"])
  expect(admin.draft("ds-test")?.keySource).toBe("env")
})

test("cached vendors are synchronous and never trigger a catalog download", async () => {
  const ai = createAi({ env: {} })
  let calls = 0
  const admin = createProviderAdmin({
    ai,
    home,
    env: {},
    catalog: {
      fetch: (async () => {
        calls++
        return Response.json({})
      }) as unknown as typeof fetch,
    },
  })
  expect(admin.cachedVendors!()).toEqual([])
  expect(admin.cachedVendors!()).not.toBeInstanceOf(Promise)
  expect(calls).toBe(0)
  ai.setCatalog!(
    createCatalog({
      vendor: {
        id: "vendor",
        name: "Vendor",
        env: ["VENDOR_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://example.test",
        models: { first: {}, second: {} },
      },
    }),
  )
  const vendors = admin.cachedVendors!()
  expect(vendors).toEqual([
    {
      id: "vendor",
      name: "Vendor",
      env: ["VENDOR_KEY"],
      dialect: "openai-chat",
      baseUrl: "https://example.test",
      models: ["first", "second"],
    },
  ])
  vendors[0]!.env.push("MUTATED")
  vendors[0]!.models!.push("mutated")
  expect(admin.cachedVendors!()[0]).toMatchObject({ env: ["VENDOR_KEY"], models: ["first", "second"] })
  expect(calls).toBe(0)
})

test.each([
  { headers: { "x-invalid": 123 } },
  { compat: { maxTokensField: "tokens" } },
  { modelOverrides: { "deepseek-chat": { fast: true } } },
  { modelOverrides: { "deepseek-chat": { fast: { kind: "service-tier" } } } },
  { modelOverrides: { "deepseek-chat": { fast: { kind: "other" } } } },
  { modelOverrides: { "deepseek-chat": { thinking: "default" } } },
  { modelOverrides: { "deepseek-chat": { contextWindow: 0 } } },
])("invalid advanced values are rejected before writing or probing: %j", async (invalid) => {
  const { admin, seen } = setup()
  const d = draft(invalid as Partial<ProviderDraft>)
  expect(() => admin.preview!(d)).toThrow()
  await expect(admin.save(d)).rejects.toThrow()
  await expect(admin.listModels(d)).rejects.toThrow()
  await expect(admin.test(d, "deepseek-chat")).rejects.toThrow()
  expect(seen).toEqual([])
  expect(() => settings()).toThrow()
  expect(() => auth()).toThrow()
})

test("clearing advanced values and a fast descriptor preserves unrelated model overrides", async () => {
  const { admin } = setup()
  await admin.save(
    draft({
      headers: { "x-team": "old" },
      compat: { streamUsage: false },
      apiKeyEnvFallbacks: ["OLD_KEY"],
      modelOverrides: {
        "deepseek-chat": { maxOutput: 4000, fast: { kind: "service-tier", value: "priority" } },
      },
    }),
  )
  const current = admin.draft("ds-test")!
  const original = settings()
  current.modelOverrides!["deepseek-chat"]!.maxOutput = 3000
  expect(admin.draft("ds-test")?.modelOverrides?.["deepseek-chat"]?.maxOutput).toBe(4000)
  expect(settings()).toEqual(original)
  const edited = {
    ...current,
    headers: {},
    compat: {},
    apiKeyEnvFallbacks: [],
    modelOverrides: { "deepseek-chat": {} },
  }
  const preview = admin.preview!(edited)
  expect(preview).toMatchObject({
    headers: {},
    compat: {},
    apiKeyEnvFallbacks: [],
    models: [{ id: "deepseek-chat", maxOutput: 4000 }, { id: "deepseek-new" }],
  })
  expect(preview.models![0]).not.toHaveProperty("fast")
  await admin.save(edited)
  expect(settings().providers["ds-test"]).toEqual(preview)
  preview.models![0]!.maxOutput = 100
  expect(settings().providers["ds-test"].models[0].maxOutput).toBe(4000)
})

test("probe expansion does not interpret placeholders inside a resolved header secret twice", async () => {
  const { admin, requests } = setup({ TOKEN: "literal-${MISSING:-must-not-expand}" })
  const edited = draft({ headers: { "x-token": "${TOKEN}" } })
  await admin.listModels(edited)
  expect((await admin.test(edited, "deepseek-chat")).ok).toBe(true)
  expect(requests.map((request) => request.headers.get("x-token"))).toEqual([
    "literal-${MISSING:-must-not-expand}",
    "literal-${MISSING:-must-not-expand}",
  ])
})

test.each(["auth", "env", "none"] as const)(
  "explicit %s credential selection survives save/reload with no fallbacks",
  async (keySource) => {
    const env = { PRIMARY_KEY: "environment-key" }
    const { admin, ai, fetch } = setup(env)
    await admin.save(draft())
    await admin.save(
      draft({ keySource, apiKey: undefined, apiKeyEnv: "PRIMARY_KEY", apiKeyEnvFallbacks: [] }),
    )
    expect(settings().providers["ds-test"].keySource).toBe(keySource)
    const reloaded = createAi({
      providers: providersFromSettings(settings().providers),
      apiKeys: loadAuth(authFile(home)).keys,
      env,
      fetch,
    })
    expect(reloaded.credentialSource?.("ds-test")).toBe(
      keySource === "auth" ? "stored" : ai.credentialSource?.("ds-test"),
    )
    expect(reloaded.providerEndpoint("ds-test").apiKey).toBe(
      keySource === "none" ? undefined : keySource === "env" ? env.PRIMARY_KEY : KEY,
    )
  },
)

test("clearing the last fallback does not reactivate retained auth.json credentials", async () => {
  const { admin, fetch } = setup({ BACKUP_KEY: "fallback-key" })
  await admin.save(draft())
  await admin.save(draft({ keySource: "none", apiKey: undefined, apiKeyEnvFallbacks: ["BACKUP_KEY"] }))
  await admin.save({ ...admin.draft("ds-test")!, apiKeyEnvFallbacks: [] })
  const reloaded = createAi({
    providers: providersFromSettings(settings().providers),
    apiKeys: loadAuth(authFile(home)).keys,
    env: { BACKUP_KEY: "fallback-key" },
    fetch,
  })
  expect(settings().providers["ds-test"].keySource).toBe("none")
  expect(reloaded.credentialSource?.("ds-test")).toBe("none")
  expect(reloaded.providerEndpoint("ds-test").apiKey).toBeUndefined()
})

test.each([false, "other"] as const)(
  "choosing the provider's own vendor resets a persisted %s catalog override",
  async (catalogId) => {
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({
        providers: {
          openai: {
            dialect: "openai-chat",
            baseUrl: "https://example.test/v1",
            catalogId,
            models: [{ id: "first", futureModelSetting: "keep" }],
            futureProviderSetting: "keep",
          },
        },
      }),
    )
    const ai = createAi({
      env: {},
      providers: providersFromSettings(settings().providers),
      catalog: createCatalog({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.openai.com/v1",
          models: { first: {} },
        },
      }),
    })
    const admin = createProviderAdmin({ ai, home, env: {} })
    const existing = admin.draft("openai")!
    const form = providerFormSpec(admin, existing)
    const edited = draftFromValues(
      { ...formDefaults(form), vendor: "openai" },
      existing.id,
      existing.catalogId,
      existing,
    )
    expect(edited.catalogId).toBe("openai")
    expect(admin.preview!(edited)).not.toHaveProperty("catalogId")
    await admin.save(edited)
    expect(settings().providers.openai).not.toHaveProperty("catalogId")
    expect(settings().providers.openai).toMatchObject({
      futureProviderSetting: "keep",
      models: [{ id: "first", futureModelSetting: "keep" }],
    })
  },
)

test("switching a keyless provider to retained fallback-only environment auth probes the saved credential", async () => {
  const { admin, requests } = setup({ ALT_KEY: "working-fallback-key" })
  await admin.save(draft({ keySource: "none", apiKey: undefined, apiKeyEnvFallbacks: ["ALT_KEY"] }))
  const edited = { ...admin.draft("ds-test")!, keySource: "env" as const }
  await admin.listModels(edited)
  await admin.test(edited, "deepseek-chat")
  await admin.save(edited)
  await admin.listModels(admin.draft("ds-test")!)
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer working-fallback-key",
    "Bearer working-fallback-key",
    "Bearer working-fallback-key",
  ])
})
