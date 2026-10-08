import path from "node:path"
import {
  type Ai,
  BUILTIN_DIALECTS,
  type CatalogModel,
  catalogProviderId,
  host,
  LISTABLE_DIALECTS,
  listModels,
  type ModelCatalog,
  type ModelOverrides,
  type ProbeEndpoint,
  ProbeError,
  type ProviderConfig,
  testConnection,
  vendorPreset,
} from "@amira/ai"
import type { ProviderAdmin, ProviderDraft, ProviderModelInfo, ProviderSettings } from "@amira/api"
import {
  amiraHome,
  authFile,
  loadAuth,
  providersFromSettings,
  readJsonFile,
  restrictToCurrentUser,
  setAuthKey,
  updateProviderInSettings,
} from "@amira/core"
import { type CatalogCacheOptions, refreshCatalog } from "./catalog.ts"

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
    return (catalog?.vendors?.() ?? [])
      .map((v) => ({
        id: v.id,
        name: v.name,
        env: v.env,
        ...(v.api?.includes("${") ? { baseUrl: v.api.trim().replace(/\/+$/, "") } : {}),
        ...vendorPreset(v),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  const checkPlaceholders = (baseUrl: string) => {
    const placeholder = /\$\{[^}]*\}?/.exec(baseUrl)?.[0]
    if (placeholder) throw new Error(`replace ${placeholder} in the base URL with its value`)
  }

  /** The key a probe of the draft should use: the one typed, the stored one, or the variable's. */
  const keyFor = (d: ProviderDraft): string | undefined => {
    if (d.keySource === "none") return undefined
    if (d.keySource === "env") return d.apiKeyEnv ? env[d.apiKeyEnv] || undefined : undefined
    return d.apiKey || storedKeys()[d.id] || undefined
  }
  const endpoint = (d: ProviderDraft): ProbeEndpoint => {
    checkPlaceholders(d.baseUrl)
    const current = config(d.id)
    const key = keyFor(d)
    return {
      dialect: d.dialect,
      baseUrl: d.baseUrl,
      ...(key ? { apiKey: key } : {}),
      ...(current?.headers ? { headers: current.headers } : {}),
      ...(current?.compat ? { compat: current.compat } : {}),
    }
  }

  /** Which catalog provider describes these models: the provider's own, or the one that knows most of them. */
  const catalogFor = (d: ProviderDraft, ids: string[]): { catalogId?: string; catalog?: ModelCatalog } => {
    const catalog = ai.catalog?.()
    const existing = d.catalogId ?? userEntry(d.id)?.catalogId ?? config(d.id)?.catalogId
    if (existing === false) return {}
    if (existing !== undefined) return { catalogId: existing, ...(catalog ? { catalog } : {}) }
    if (!catalog) return {}
    const own = catalogProviderId({ id: d.id, ...(existing !== undefined ? { catalogId: existing } : {}) })
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
    const { catalogId, catalog } = catalogFor(
      d,
      listed.map((m) => m.id),
    )
    return listed.map((m): ProviderModelInfo => {
      const c: CatalogModel | undefined = catalogId ? catalog?.find(catalogId, m.id) : undefined
      const contextWindow = c?.contextWindow ?? m.contextWindow
      const maxOutput = c?.maxOutput ?? m.maxOutput
      return {
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutput ? { maxOutput } : {}),
        ...(c?.cost ? { cost: { input: c.cost.input, output: c.cost.output } } : {}),
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
    if (d.keySource === "env" && !ENV.test(d.apiKeyEnv ?? "")) {
      throw new Error("the environment variable name must be letters, digits and _")
    }
  }

  return {
    dialects: () => dialectIds(ai),
    vendors,
    exists: (id) => config(id) !== undefined,
    draft: (id) => {
      const p = config(id)
      if (!p) return undefined
      const stored = storedKeys()[id] !== undefined
      const keySource =
        p.apiKeyEnv && !(stored && !env[p.apiKeyEnv]) ? "env" : stored ? "auth" : p.apiKeyEnv ? "env" : "none"
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
      try {
        const listed = await listModels(endpoint(d), {
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(signal ? { signal } : {}),
        })
        return describe(d, listed)
      } catch (err) {
        if (err instanceof ProbeError && err.kind === "auth" && !keyFor(d)) {
          throw new Error(`${err.message}; no key was sent: enter one first`)
        }
        throw err
      }
    },
    describeModels: (d, ids) =>
      describe(
        d,
        ids.map((id) => ({ id })),
      ),
    test: async (d, model, signal) => {
      const r = await testConnection(endpoint(d), model, {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(signal ? { signal } : {}),
      })
      return { ok: r.ok, latencyMs: r.latencyMs, message: r.message }
    },
    save: async (d) => {
      check(d)
      const { catalogId } = catalogFor(d, d.models)
      const { after } = updateProviderInSettings(settingsFile, d.id, (cur) =>
        entryFor(cur ?? {}, d, catalogId && catalogId !== d.id ? catalogId : undefined),
      )
      const lines = [`Saved provider "${d.id}" (${d.dialect}, ${d.baseUrl}) to ${settingsFile}.`]
      if (catalogId && catalogId !== d.id && catalogId !== catalogProviderId({ id: d.id })) {
        lines.push(`Model details from ${catalogId} (metadata only; model list unchanged).`)
      }
      let key: string | undefined
      if (d.keySource === "auth") {
        if (d.apiKey) {
          setAuthKey(keysFile, d.id, d.apiKey)
          const warning = await restrict(keysFile)
          lines.push(`Key: stored in ${keysFile} (${keyHint(d.apiKey)}).`)
          if (warning) lines.push(`Warning: ${warning}.`)
          key = d.apiKey
        } else {
          key = storedKeys()[d.id]
          lines.push(
            key
              ? `Key: the one stored in ${keysFile} (${keyHint(key)}).`
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
      if (live) ai.registerProvider(key ? { ...live, apiKey: key } : live)
      // A provider switched away from auth.json must not keep using the stored key meanwhile.
      if (d.keySource !== "auth") ai.setStoredKey?.(d.id, undefined)
      const inUse = opts.currentProvider?.() === d.id
      const infos = describe(
        d,
        d.models.map((id) => ({ id })),
      )
      if (infos.length) lines.push(`Models: ${infos.map(modelNote).join("; ")}.`)
      const now = opts.onSaved?.(d.id, d.models)
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
      ai.registerProvider({ ...p, apiKey: apiKey.trim() })
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
function entryFor(cur: ProviderSettings, d: ProviderDraft, catalogId: string | undefined): ProviderSettings {
  const next: ProviderSettings = { ...cur, dialect: d.dialect, baseUrl: d.baseUrl }
  if (d.keySource === "env") next.apiKeyEnv = d.apiKeyEnv!
  else {
    delete next.apiKeyEnv
    delete next.apiKeyEnvFallbacks
  }
  const old = new Map((cur.models ?? []).flatMap((m) => (m.id ? [[m.id, m] as const] : [])))
  const models: ModelOverrides[] = d.models.map((id) => old.get(id) ?? { id })
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
  for (const k of ["contextWindow", "maxOutput"] as const) {
    const v = d.defaults?.[k]
    if (v) defaultModel[k] = v
    else delete defaultModel[k]
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
