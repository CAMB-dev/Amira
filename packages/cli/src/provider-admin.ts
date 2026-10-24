import path from "node:path"
import {
  type Ai,
  BUILTIN_DIALECTS,
  catalogProviderId,
  createAi,
  findCatalogModel,
  host,
  LISTABLE_DIALECTS,
  listModels,
  type ModelCatalog,
  type ModelOverrides,
  type ProbeEndpoint,
  ProbeError,
  type ProviderConfig,
  resolveModelInfo,
  testConnection,
  vendorPreset,
} from "@amira/ai"
import type {
  ModelSettings,
  ProviderAdmin,
  ProviderDraft,
  ProviderModelInfo,
  ProviderSettings,
} from "@amira/api"
import {
  amiraHome,
  authFile,
  deepMerge,
  loadAuth,
  providersFromSettings,
  readJsonFile,
  restrictToCurrentUser,
  setAuthKey,
  updateProviderInSettings,
  validateSettings,
} from "@amira/core"
import { type CatalogCacheOptions, refreshCatalog } from "./catalog.ts"
import { installProviderModelCache } from "./provider-models.ts"
import { USER_AGENT } from "./user-agent.ts"

export interface ProviderAdminOptions {
  /** The session's providers; saved ones are registered on it at once. */
  ai: Ai
  /** Amira's user directory. Default amiraHome(). */
  home?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  /** Catalog download options; separate from provider probes, and injectable for offline tests. */
  catalog?: CatalogCacheOptions
  platform?: string
  /** The provider of the model in use, which cannot be removed. */
  currentProvider?: () => string | undefined
  /**
   * Called once a provider is saved and registered, with its models in order: a session starts
   * using it (the first provider, when no model is picked yet) or picks up an edit of the one
   * in use. Returns the model it runs on then ("provider/model"), if it changed to it.
   */
  onSaved?: (id: string, models: string[]) => string | undefined
  /** Capture session-specific authority before an admitted save crosses an async filesystem step. */
  captureOnSaved?: () => ProviderAdminOptions["onSaved"]
  /** Makes auth.json private on Windows; injectable for tests. */
  restrict?: (file: string) => Promise<string | undefined>
}

const ID = /^[a-z0-9][a-z0-9._-]*$/
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/

/** "…abcd" for a key long enough that its last four characters say nothing; else "(set)". */
export function keyHint(key: string): string {
  return key.length >= 12 ? `…${key.slice(-4)}` : "(set)"
}

/**
 * ProviderAdmin over the user settings.json and auth.json: what /provider (and `amira
 * provider`) use to add, edit and remove providers. Writes go through the settings lock;
 * a saved provider is registered on `ai` right away, with its stored key.
 */
export function createProviderAdmin(opts: ProviderAdminOptions): ProviderAdmin {
  const { ai } = opts
  const home = opts.home ?? amiraHome()
  const modelCache = installProviderModelCache(ai, path.join(home, "cache", "provider-models.json"))
  const env = opts.env ?? process.env
  const settingsFile = path.join(home, "settings.json")
  const keysFile = authFile(home)
  const restrict =
    opts.restrict ??
    ((file: string) => restrictToCurrentUser(file, { ...(opts.platform ? { platform: opts.platform } : {}) }))
  const storedKeys = () => {
    try {
      return loadAuth(keysFile, opts.platform ?? process.platform).keys
    } catch {
      return {}
    }
  }
  const userEntry = (id: string): ProviderSettings | undefined => {
    const raw = readJsonFile(settingsFile) as { providers?: Record<string, ProviderSettings> } | undefined
    return raw?.providers?.[id]
  }
  const config = (id: string) => ai.providers().find((p) => p.id === id)
  const vendorList = (catalog: ModelCatalog | undefined) =>
    (catalog?.vendors?.() ?? [])
      .map((v) => ({
        id: v.id,
        name: v.name,
        env: [...v.env],
        ...(catalog?.list ? { models: catalog.list(v.id) } : {}),
        ...(v.api?.includes("${") ? { baseUrl: v.api.trim().replace(/\/+$/, "") } : {}),
        ...vendorPreset(v),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const cachedVendors = () => vendorList(ai.catalog?.())
  let vendorRefresh: Promise<ModelCatalog | undefined> | undefined
  const vendors = async (request: { onLoading?: () => void } = {}) => {
    let catalog = ai.catalog?.()
    if (!catalog?.vendors?.().length) {
      if (!vendorRefresh) {
        request.onLoading?.()
        vendorRefresh = refreshCatalog({
          file: path.join(home, "cache", "models.json"),
          ...opts.catalog,
        })
      }
      const refreshed = await vendorRefresh
      if (refreshed) {
        ai.setCatalog?.(refreshed)
        catalog = refreshed
      }
    }
    return vendorList(catalog)
  }

  const checkPlaceholders = (baseUrl: string) => {
    const placeholder = /\$\{[^}]*\}?/.exec(baseUrl)?.[0]
    if (placeholder) throw new Error(`replace ${placeholder} in the base URL with its value`)
  }

  const keyFromEnv = (p: Pick<ProviderConfig, "apiKeyEnv" | "apiKeyEnvFallbacks">): string | undefined => {
    for (const name of [p.apiKeyEnv, ...(p.apiKeyEnvFallbacks ?? [])]) {
      const key = name ? env[name]?.trim() : undefined
      if (key) return key
    }
    return undefined
  }

  /** Configured credentials come from Ai, never a disk reload; explicit draft edits stay local. */
  const keyFor = (d: ProviderDraft): string | undefined => {
    if (d.keySource === "none") return undefined
    const typed = d.apiKey?.trim()
    if (d.keySource === "auth" && typed) return typed
    const current = config(d.id)
    const samePrimary = current && (d.apiKeyEnv || undefined) === (current.apiKeyEnv || undefined)
    const selectedEnv = {
      apiKeyEnv: d.apiKeyEnv,
      apiKeyEnvFallbacks: d.apiKeyEnvFallbacks ?? (samePrimary ? current.apiKeyEnvFallbacks : undefined),
    }
    const sameEnv =
      samePrimary &&
      JSON.stringify(selectedEnv.apiKeyEnvFallbacks ?? []) ===
        JSON.stringify(current.apiKeyEnvFallbacks ?? [])
    if (d.keySource === "env" && !sameEnv) return keyFromEnv(selectedEnv)
    if (current) {
      const live = ai.providerEndpoint(d.id)
      const source = live.credentialSource
      if (
        (d.keySource === "auth" && (source === "explicit" || source === "stored")) ||
        (d.keySource === "env" &&
          sameEnv &&
          (source === "env" ||
            (source === "none" && current.keySource !== "auth" && current.keySource !== "none")))
      )
        return live.apiKey
    }
    if (d.keySource === "env") {
      // Choosing environment authentication must not silently test an auth.json fallback.
      return keyFromEnv(selectedEnv)
    }
    return storedKeys()[d.id]?.trim() || undefined
  }
  const endpoint = (d: ProviderDraft): ProbeEndpoint => {
    check(d)
    const current = config(d.id)
    const key = keyFor(d)
    const headers = d.headers ?? current?.headers
    const compat = d.compat ?? current?.compat
    return {
      dialect: d.dialect,
      baseUrl: d.baseUrl,
      ...(key ? { apiKey: key } : {}),
      ...(headers
        ? {
            // Resolve through Ai so probes and ordinary requests share single-pass expansion.
            headers: createAi({
              env,
              providers: [{ id: d.id, dialect: d.dialect, baseUrl: d.baseUrl, headers }],
            }).providerEndpoint(d.id).headers,
          }
        : {}),
      ...(compat ? { compat } : {}),
    }
  }

  /** Which catalog provider describes these models: the provider's own, or the one that knows most of them. */
  const catalogFor = (
    d: ProviderDraft,
    ids: string[],
  ): { catalogId?: string | false; catalog?: ModelCatalog } => {
    const catalog = ai.catalog?.()
    const existing = d.catalogId ?? userEntry(d.id)?.catalogId ?? config(d.id)?.catalogId
    if (existing === false) return { catalogId: false }
    if (existing !== undefined) return { catalogId: existing, ...(catalog ? { catalog } : {}) }
    if (!catalog) return {}
    const own = catalogProviderId({ id: d.id, ...(existing !== undefined ? { catalogId: existing } : {}) })
    if (!own) return { catalogId: false }
    const known = (cid: string) => ids.filter((m) => catalog.find(cid, m)).length
    if (own && (catalog.vendor?.(own) || known(own) > 0 || !ids.length)) return { catalogId: own, catalog }
    const where = host(d.baseUrl).toLowerCase()
    const hits = (catalog.providers?.() ?? [])
      .map((cid) => ({ id: cid, n: known(cid), near: where.includes(cid.toLowerCase()) }))
      .filter((h) => h.n > 0)
      .sort((x, y) => y.n - x.n || Number(y.near) - Number(x.near))
    const [best, next] = hits
    // Several vendors list the same ids (openai, azure, ...): only an unambiguous match counts.
    const clear = best && (!next || next.n < best.n || (best.near && !next.near))
    return clear ? { catalogId: best.id, catalog } : own ? { catalogId: own, catalog } : {}
  }

  const describe = (
    d: ProviderDraft,
    listed: { id: string; name?: string; contextWindow?: number; maxOutput?: number }[],
  ) => {
    const { catalogId, catalog } = catalogFor(d, d.models)
    const entry = entryFor(
      userEntry(d.id) ?? config(d.id) ?? {},
      d,
      catalogId && catalogId !== d.id ? catalogId : undefined,
    )
    const provider: ProviderConfig = { ...entry, id: d.id, dialect: d.dialect, baseUrl: d.baseUrl }
    return listed.map((m): ProviderModelInfo => {
      const c = findCatalogModel(catalog, provider, m.id)
      const resolved = resolveModelInfo(provider, m.id, c, { ...modelCache.lookup(provider, m.id), ...m })
      return {
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        contextWindow: resolved.contextWindow,
        maxOutput: resolved.maxOutput,
        ...(resolved.cost ? { cost: { input: resolved.cost.input, output: resolved.cost.output } } : {}),
        inCatalog: c !== undefined,
      }
    })
  }

  const check = (d: ProviderDraft) => {
    if (!ID.test(d.id)) throw new Error(`provider id "${d.id}" must be lower-case letters, digits and . _ -`)
    if (!dialectIds(ai).includes(d.dialect)) {
      throw new Error(`unknown dialect "${d.dialect}"; one of: ${dialectIds(ai).join(", ")}`)
    }
    checkPlaceholders(d.baseUrl)
    let url: URL
    try {
      url = new URL(d.baseUrl)
    } catch {
      throw new Error(`base URL "${d.baseUrl}" is not a URL`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("the base URL must be http or https")
    if (d.keySource === "env" && !(d.apiKeyEnv ? ENV.test(d.apiKeyEnv) : d.apiKeyEnvFallbacks?.length)) {
      throw new Error("the environment variable name must be letters, digits and _")
    }
    validateSettings({ providers: { [d.id]: entryFor({}, d, undefined) } }, settingsFile)
  }

  const preview = (d: ProviderDraft): ProviderSettings => {
    check(d)
    const { catalogId } = catalogFor(d, d.models)
    const display = structuredClone(
      entryFor(userEntry(d.id) ?? {}, d, catalogId && catalogId !== d.id ? catalogId : undefined),
    )
    omitInlineKeys(display)
    return display
  }

  return {
    dialects: () => dialectIds(ai),
    vendors,
    cachedVendors,
    preview,
    exists: (id) => config(id) !== undefined,
    draft: (id) => {
      const p = config(id)
      if (!p) return undefined
      // A disk entry can differ from, or be disabled in, the live Ai.
      const source = ai.credentialSource?.(id) ?? ai.providerEndpoint(id).credentialSource
      const keySource =
        source === "explicit" || source === "stored"
          ? "auth"
          : (p.keySource ??
            (source === "env" || p.apiKeyEnv || p.apiKeyEnvFallbacks?.length ? "env" : "none"))
      const raw = userEntry(id)
      const headers = raw?.headers ?? p.headers
      const compat = raw?.compat ?? p.compat
      const modelOverrides = Object.fromEntries(
        (raw?.models ?? p.models ?? []).flatMap((m) => (m.id ? [[m.id, structuredClone(m)]] : [])),
      )
      const d = p.defaultModel
      const defaults: NonNullable<ProviderDraft["defaults"]> = {
        ...(d?.contextWindow ? { contextWindow: d.contextWindow } : {}),
        ...(d?.maxOutput ? { maxOutput: d.maxOutput } : {}),
        ...(d?.caps?.thinking !== undefined ? { thinking: d.caps.thinking } : {}),
        ...(d?.caps?.images !== undefined ? { images: d.caps.images } : {}),
        ...(d?.caps?.promptCache !== undefined ? { promptCache: d.caps.promptCache } : {}),
      }
      return {
        id,
        dialect: p.dialect,
        baseUrl: p.baseUrl,
        ...(p.catalogId !== undefined ? { catalogId: p.catalogId } : {}),
        keySource,
        ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
        ...(p.apiKeyEnvFallbacks ? { apiKeyEnvFallbacks: [...p.apiKeyEnvFallbacks] } : {}),
        ...(headers ? { headers: { ...headers } } : {}),
        ...(compat ? { compat: { ...compat } } : {}),
        ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}),
        models: (p.models ?? []).flatMap((m) => (m.id ? [m.id] : [])),
        defaults,
      }
    },
    storedKeyHint: (id) => {
      const k = storedKeys()[id]
      return k ? keyHint(k) : undefined
    },
    envIsSet: (name) => Boolean(env[name]),
    listModels: async (d, signal) => {
      const ep = endpoint(d)
      try {
        const listed = await listModels(ep, {
          userAgent: USER_AGENT,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(signal ? { signal } : {}),
        })
        await modelCache.record(d, listed)
        return describe(d, listed)
      } catch (err) {
        const message = probeDiagnostic(
          ep,
          err instanceof Error ? err.message : String(err),
          err instanceof ProbeError ? err.kind : undefined,
          err instanceof ProbeError ? err.status : undefined,
        )
        if (err instanceof ProbeError) {
          if (err.kind === "auth" && !ep.apiKey && !hasCustomHeaders(ep)) {
            throw new Error(`${message}; no key was sent: enter one first`)
          }
          throw new ProbeError(message, err.kind, err.status)
        }
        throw new Error(message)
      }
    },
    describeModels: (d, ids) =>
      describe(
        d,
        ids.map((id) => ({ id })),
      ),
    test: async (d, model, signal) => {
      const ep = endpoint(d)
      try {
        const r = await testConnection(ep, model, {
          userAgent: USER_AGENT,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(signal ? { signal } : {}),
        })
        return {
          ok: r.ok,
          latencyMs: r.latencyMs,
          message: r.ok ? r.message : probeDiagnostic(ep, r.message, r.failure, r.status),
        }
      } catch (err) {
        throw new Error(probeDiagnostic(ep, err instanceof Error ? err.message : String(err)))
      }
    },
    save: async (d, saveOptions = {}) => {
      const onSaved = opts.captureOnSaved ? opts.captureOnSaved() : opts.onSaved
      const apiKey = d.apiKey?.trim()
      check(d)
      const { catalogId } = catalogFor(d, d.models)
      const { after } = updateProviderInSettings(settingsFile, d.id, (cur) =>
        entryFor(
          cur ?? {},
          d,
          catalogId && catalogId !== d.id ? catalogId : undefined,
          saveOptions.persistKeySource ?? true,
        ),
      )
      const lines = [`Saved provider "${d.id}" (${d.dialect}, ${d.baseUrl}) to ${settingsFile}.`]
      if (catalogId && catalogId !== d.id && catalogId !== catalogProviderId({ id: d.id })) {
        lines.push(`Model details from ${catalogId} (metadata only; model list unchanged).`)
      }
      let key: string | undefined
      if (d.keySource === "auth") {
        if (apiKey) {
          setAuthKey(keysFile, d.id, apiKey)
          const warning = await restrict(keysFile)
          lines.push(`Key: stored in ${keysFile} (${keyHint(apiKey)}).`)
          if (warning) lines.push(`Warning: ${warning}.`)
          key = apiKey
        } else {
          key = keyFor(d)
          lines.push(
            key
              ? `Key: kept the existing credential (${keyHint(key)}).`
              : `Key: none yet; add one with /provider key ${d.id}.`,
          )
        }
      } else if (d.keySource === "env") {
        lines.push(`Key: read from $${d.apiKeyEnv} (${env[d.apiKeyEnv!] ? "set" : "not set now"}).`)
        if (storedKeys()[d.id])
          lines.push(`A key is still stored in ${keysFile}; /provider remove deletes it.`)
      } else {
        lines.push("Key: none.")
      }
      const [live] = providersFromSettings({ [d.id]: after ?? {} })
      if (live) {
        ai.registerProvider(
          d.keySource === "env" ? live : { ...live, keySource: d.keySource, ...(key ? { apiKey: key } : {}) },
        )
      }
      // Keep the chosen live credential, including when an explicit empty key blocked a stored one.
      if (d.keySource !== "auth" || !key) ai.setStoredKey?.(d.id, undefined)
      const inUse = opts.currentProvider?.() === d.id
      const infos = describe(
        d,
        d.models.map((id) => ({ id })),
      )
      if (infos.length) lines.push(`Models: ${infos.map(modelNote).join("; ")}.`)
      const now = onSaved?.(d.id, d.models)
      if (now) lines.push(inUse ? `In use: the changes apply now (${now}).` : `Now using ${now}.`)
      else if (inUse) lines.push("It is in use: run /model again to pick up the changes.")
      else lines.push(`Switch to it with /model ${d.id}/${d.models[0] ?? "<model>"}.`)
      return lines.join("\n")
    },
    remove: async (id, { removeKey }) => {
      if (opts.currentProvider?.() === id) {
        throw new Error(`provider "${id}" is in use; switch to another model with /model first`)
      }
      const { before } = updateProviderInSettings(settingsFile, id, () => undefined)
      if (!before && !(removeKey && storedKeys()[id])) {
        throw new Error(`provider "${id}" is not in ${settingsFile}`)
      }
      const lines = before ? [`Removed provider "${id}" from ${settingsFile}.`] : []
      if (removeKey && setAuthKey(keysFile, id, undefined)) {
        lines.push(`Deleted its key from ${keysFile}.`)
        ai.setStoredKey?.(id, undefined)
        // A rewrite makes a new file, which gets the folder's ACL again.
        const warning = await restrict(keysFile)
        if (warning) lines.push(`Warning: ${warning}.`)
      }
      if (before) ai.removeProvider?.(id)
      else {
        // Only the key went away: the provider stays, without it.
        const p = config(id)
        if (p) ai.registerProvider(withoutKey(p))
      }
      return lines.join("\n")
    },
    setKey: async (id, apiKey) => {
      const p = config(id)
      if (!p) throw new Error(`unknown provider "${id}"`)
      if (!apiKey.trim()) throw new Error("the key is empty")
      setAuthKey(keysFile, id, apiKey.trim())
      const warning = await restrict(keysFile)
      if (p.keySource === "none" && userEntry(id)?.keySource === "none") {
        updateProviderInSettings(settingsFile, id, (cur) => {
          if (!cur) return cur
          const next = { ...cur }
          next.keySource = "auth"
          return next
        })
      }
      ai.registerProvider({
        ...p,
        ...(p.keySource === "none" ? { keySource: "auth" } : {}),
        apiKey: apiKey.trim(),
      })
      ai.setStoredKey?.(id, apiKey.trim())
      const lines = [`Stored a key for "${id}" in ${keysFile} (${keyHint(apiKey.trim())}); in use now.`]
      if (p.apiKeyEnv && env[p.apiKeyEnv]) {
        lines.push(`Note: $${p.apiKeyEnv} is set too; at startup it wins over auth.json.`)
      }
      if (warning) lines.push(`Warning: ${warning}.`)
      return lines.join("\n")
    },
  }
}

/** Remove legacy inline secrets only from the display clone; unknown disk settings still roundtrip. */
function omitInlineKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) omitInlineKeys(item)
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.toLowerCase() === "apikey") delete (value as Record<string, unknown>)[key]
      else omitInlineKeys(item)
    }
  }
}

function hasCustomHeaders(ep: ProbeEndpoint): boolean {
  return Object.values(ep.headers ?? {}).some(Boolean)
}

/** Custom headers can carry arbitrary secrets; never display untrusted provider or transport text. */
function probeDiagnostic(
  ep: ProbeEndpoint,
  message: string,
  failure?: ProbeError["kind"],
  status?: number,
): string {
  if (!hasCustomHeaders(ep)) return message
  const where = host(ep.baseUrl)
  switch (failure) {
    case "auth":
      return `authentication was rejected by ${where} (HTTP ${status}); check the API key or custom authentication headers`
    case "not_found":
      return `HTTP 404 from ${where}: check the base URL and model id`
    case "network":
      return `cannot reach ${where}: check the connection and base URL`
    case "timeout":
      return `no answer from ${where}: the request timed out`
    case "aborted":
      return "cancelled"
    case "unsupported":
      return `listing models is not supported for dialect "${ep.dialect}"; type the model ids instead`
    case "format":
      return `unexpected response from ${where}: check the base URL and model id`
    default:
      return `${status === undefined ? "request failed" : `HTTP ${status}`} from ${where}: check the provider settings`
  }
}

function dialectIds(ai: Ai): string[] {
  // Dialects extensions registered are not listed by Ai; the built-in ones can be probed.
  const used = ai.providers().map((p) => p.dialect)
  return [...new Set([...LISTABLE_DIALECTS, ...BUILTIN_DIALECTS.map((d) => d.id), ...used])].filter(
    (d) => d !== "mock",
  )
}

function withoutKey(p: ProviderConfig): ProviderConfig {
  const { apiKey: _k, ...rest } = p
  return rest
}

/** The settings entry for a draft, over what the entry had: unknown keys and model overrides stay. */
function entryFor(
  cur: ProviderSettings,
  d: ProviderDraft,
  catalogId: string | undefined,
  persistKeySource = true,
): ProviderSettings {
  const next: ProviderSettings = { ...cur, dialect: d.dialect, baseUrl: d.baseUrl }
  if (d.keySource === "env" && d.apiKeyEnv) next.apiKeyEnv = d.apiKeyEnv
  else delete next.apiKeyEnv
  if (d.apiKeyEnvFallbacks !== undefined) next.apiKeyEnvFallbacks = [...d.apiKeyEnvFallbacks]
  // Explicit selections survive restart independently of stored keys and fallback-list length.
  // Only the flags-only caller opts into the legacy settings shape.
  if (persistKeySource || cur.keySource !== undefined) next.keySource = d.keySource
  if (d.headers !== undefined) next.headers = { ...d.headers }
  if (d.compat !== undefined) next.compat = { ...d.compat }
  const old = new Map((cur.models ?? []).flatMap((m) => (m.id ? [[m.id, m] as const] : [])))
  const models: ModelSettings[] = d.models.map((id) => {
    const override = d.modelOverrides?.[id]
    const model = deepMerge(old.get(id) ?? {}, { ...override, id })
    if (override !== undefined) {
      // A fast entry removed in the form restores the catalog/default, not the old override.
      if (override.fast !== undefined) model.fast = structuredClone(override.fast)
      else delete model.fast
    }
    return model
  })
  if (models.length) next.models = models
  else delete next.models
  if (d.catalogId === false) next.catalogId = false
  else if (catalogId) next.catalogId = catalogId
  else if (d.catalogId !== undefined) delete next.catalogId
  const caps: NonNullable<ModelOverrides["caps"]> = { ...cur.defaultModel?.caps }
  for (const cap of ["thinking", "images", "promptCache"] as const) {
    const want = d.defaults?.[cap]
    if (want === undefined) continue
    // False is the default, so it goes without saying.
    if (want) caps[cap] = want
    else delete caps[cap]
  }
  const defaultModel: ModelOverrides = { ...cur.defaultModel }
  if (d.defaults !== undefined) {
    for (const k of ["contextWindow", "maxOutput"] as const) {
      const v = d.defaults[k]
      if (v !== undefined) defaultModel[k] = v
      else delete defaultModel[k]
    }
  }
  if (Object.keys(caps).length) defaultModel.caps = caps
  else delete defaultModel.caps
  if (Object.keys(defaultModel).length) next.defaultModel = defaultModel
  else delete next.defaultModel
  return next
}

/** "deepseek-chat (128k context, $0.27/$1.10 per M)", or that the defaults apply. */
export function modelNote(m: ProviderModelInfo): string {
  if (!m.inCatalog && !m.contextWindow) return `${m.id} (not in the catalog: the defaults apply)`
  const parts = [
    ...(m.contextWindow ? [`${tokens(m.contextWindow)} context`] : []),
    ...(m.cost ? [`$${m.cost.input}/$${m.cost.output} per M`] : []),
  ]
  return parts.length ? `${m.id} (${parts.join(", ")})` : m.id
}

function tokens(n: number): string {
  return n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n)
}
