import { builtinFastCost, builtinFastOption } from "./fast-mode.ts"
import type { FastOption, ModelCaps, ModelInfo } from "./types.ts"

/** What the catalog knows about one model; every field is optional. */
export interface CatalogModel {
  contextWindow?: number
  maxOutput?: number
  caps?: Partial<ModelCaps>
  fast?: FastOption | false
  cost?: NonNullable<ModelInfo["cost"]>
}

/** Token limits only; safe to borrow without another endpoint's prices or capabilities. */
export type ModelLimits = Pick<CatalogModel, "contextWindow" | "maxOutput">

/** Connection metadata for one models.dev vendor, separate from configured providers. */
export interface CatalogVendor {
  id: string
  name: string
  env: string[]
  npm: string
  api?: string
  doc?: string
}

/** Model facts by catalog provider id and model id (D51). */
export interface ModelCatalog {
  find(catalogProvider: string, modelId: string): CatalogModel | undefined
  /** Every model id the catalog lists for a provider, e.g. to offer them for completion. */
  list?(catalogProvider: string): string[]
  /** Every catalog provider id. */
  providers?(): string[]
  /** Connection metadata, when available (older caches contain only models). */
  vendor?(id: string): CatalogVendor | undefined
  vendors?(): CatalogVendor[]
}

/**
 * Amira provider ids whose catalog id differs, or that the catalog must not describe
 * (local servers, where limits depend on how the model was loaded). Others map to themselves.
 */
export const CATALOG_PROVIDER_IDS: Record<string, string | false> = {
  gemini: "google",
  moonshot: "moonshotai",
  together: "togetherai",
  fireworks: "fireworks-ai",
  bedrock: "amazon-bedrock",
  "deepseek-anthropic": "deepseek",
  ollama: false,
  lmstudio: false,
}

/** The catalog provider for an Amira provider: its own `catalogId`, the table above, or its id. */
export function catalogProviderId(p: { id: string; catalogId?: string | false }): string | undefined {
  const mapped = Object.hasOwn(CATALOG_PROVIDER_IDS, p.id) ? CATALOG_PROVIDER_IDS[p.id] : undefined
  const id = p.catalogId ?? mapped ?? p.id
  return id === false ? undefined : id
}

const borrowedLimits = new WeakMap<ModelCatalog, Map<string, ModelLimits | undefined>>()

/** Own catalog metadata, with only missing token limits borrowed across vendors. */
export function findCatalogModel(
  catalog: ModelCatalog | undefined,
  provider: { id: string; catalogId?: string | false },
  modelId: string,
): CatalogModel | undefined {
  const id = catalogProviderId(provider)
  if (!catalog || !id) return undefined
  const own = catalog.find(id, modelId)
  if (own?.contextWindow !== undefined && own.maxOutput !== undefined) return own
  let memo = borrowedLimits.get(catalog)
  if (!memo) {
    memo = new Map()
    borrowedLimits.set(catalog, memo)
  }
  if (!memo.has(modelId)) {
    const collect = (mid: string): ModelLimits | undefined => {
      const limits: ModelLimits = {}
      for (const vendor of catalog.providers?.() ?? []) addLimits(limits, catalog.find(vendor, mid))
      return Object.keys(limits).length ? limits : undefined
    }
    const bare = modelId.replace(/^models\//, "")
    memo.set(
      modelId,
      collect(modelId) ??
        (bare.includes("/") ? collect(bare.slice(bare.indexOf("/") + 1)) : undefined) ??
        fuzzyIndex(catalog).get(normalizedModelId(modelId)),
    )
  }
  const limits = memo.get(modelId)
  if (!limits) return own
  return {
    ...own,
    ...(own?.contextWindow === undefined && limits.contextWindow !== undefined
      ? { contextWindow: limits.contextWindow }
      : {}),
    ...(own?.maxOutput === undefined && limits.maxOutput !== undefined
      ? { maxOutput: limits.maxOutput }
      : {}),
  }
}

/** Keeps the smaller of each limit: when entries disagree, the safe one. */
function addLimits(limits: ModelLimits, model: ModelLimits | undefined): void {
  for (const field of ["contextWindow", "maxOutput"] as const) {
    const value = model?.[field]
    if (value !== undefined) limits[field] = Math.min(limits[field] ?? value, value)
  }
}

/** Routing and pricing tags that leave the model as it is (`phi3:mini` is another model). */
const TAG = /:(?:free|beta|thinking|online|nitro|floor|extended|exacto)$/
/** `-latest` is not one: an alias may point at another generation. */
const SNAPSHOT = /(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2})$/

/**
 * A model id without the decorations relays add to the same model: case, any leading
 * `vendor/` segments, routing tags (`:free`, `:beta`, `:thinking`, ...; see TAG), trailing
 * date stamps, and `.` for `-` between version digits
 * (`claude-sonnet-4.5` is `claude-sonnet-4-5`). Nothing else is cut, so `gpt-5-mini` stays
 * apart from `gpt-5`.
 */
function normalizedModelId(modelId: string): string {
  let id = modelId.toLowerCase()
  id = id.slice(id.lastIndexOf("/") + 1)
  for (let prev = ""; prev !== id; ) {
    prev = id
    id = id.replace(TAG, "").replace(SNAPSHOT, "")
  }
  return id.replace(/(\d)\.(?=\d)/g, "$1-")
}

const fuzzyIndexes = new WeakMap<ModelCatalog, Map<string, ModelLimits>>()

/** Every vendor's token limits by normalized model id, built once per catalog. */
function fuzzyIndex(catalog: ModelCatalog): Map<string, ModelLimits> {
  let index = fuzzyIndexes.get(catalog)
  if (index) return index
  index = new Map()
  for (const vendor of catalog.providers?.() ?? []) {
    for (const mid of catalog.list?.(vendor) ?? []) {
      const model = catalog.find(vendor, mid)
      if (model?.contextWindow === undefined && model?.maxOutput === undefined) continue
      const key = normalizedModelId(mid)
      if (!key) continue
      const limits = index.get(key) ?? {}
      addLimits(limits, model)
      index.set(key, limits)
    }
  }
  fuzzyIndexes.set(catalog, index)
  return index
}

type Raw = Record<string, any>

/** A catalog over models.dev's api.json, or over the trimmed form trimModelsDev returns. */
export function createCatalog(data: unknown): ModelCatalog {
  const providers: Raw = isObject(data) ? data : {}
  const mapped = new Map<string, CatalogModel | undefined>()
  return {
    find(provider, modelId) {
      const models = providers[provider]?.models
      if (!isObject(models)) return undefined
      const key = `${provider}\n${modelId}`
      if (!mapped.has(key)) {
        const raw = lookup(models, modelId)
        let model = toCatalogModel(raw)
        if (isObject(raw)) {
          const preset = builtinFastOption(provider, modelId)
          const taggedPriority =
            provider === "deepinfra" &&
            (raw.tags?.includes("priority") || raw.service_tiers?.includes("priority"))
          if ((preset || taggedPriority) && model?.fast === undefined) {
            model ??= {}
            model.fast = preset ?? { kind: "service-tier", value: "priority" }
          }
          const fast = builtinFastCost(provider, modelId)
          if (fast && model?.cost && !model.cost.fast) model.cost = { ...model.cost, fast }
        }
        mapped.set(key, model)
      }
      return mapped.get(key)
    },
    list(provider) {
      const models = providers[provider]?.models
      return isObject(models) ? Object.keys(models) : []
    },
    providers: () => Object.keys(providers).filter((p) => isObject(providers[p]?.models)),
    vendor: (id) => (Object.hasOwn(providers, id) ? toCatalogVendor(providers[id]) : undefined),
    vendors: () =>
      Object.values(providers).flatMap((p) => {
        const vendor = toCatalogVendor(p)
        return vendor ? [vendor] : []
      }),
  }
}

function lookup(models: Raw, modelId: string): unknown {
  const bare = modelId.replace(/^models\//, "")
  if (models[modelId] ?? models[bare]) return models[modelId] ?? models[bare]
  const lower = bare.toLowerCase()
  const hits = Object.keys(models).filter((k) => k.toLowerCase() === lower)
  return hits.length === 1 ? models[hits[0]!] : undefined
}

export function toCatalogModel(raw: unknown): CatalogModel | undefined {
  if (!isObject(raw)) return undefined
  const out: CatalogModel = {}
  if (raw.fast === false) out.fast = false
  else if (raw.fast?.kind === "anthropic-speed") out.fast = { kind: "anthropic-speed" }
  else if (raw.fast?.kind === "service-tier" && typeof raw.fast.value === "string") out.fast = { ...raw.fast }
  if (positive(raw.limit?.context)) out.contextWindow = raw.limit.context
  if (positive(raw.limit?.output)) out.maxOutput = raw.limit.output
  const caps: Partial<ModelCaps> = {}
  if (typeof raw.tool_call === "boolean") caps.tools = raw.tool_call ? "native" : "none"
  if (Array.isArray(raw.modalities?.input)) caps.images = raw.modalities.input.includes("image")
  if (typeof raw.reasoning === "boolean") caps.thinking = raw.reasoning
  // A price for cache writes means caching is opted into with explicit markers.
  if (price(raw.cost?.cache_write)) caps.promptCache = true
  if (Object.keys(caps).length) out.caps = caps
  const c = raw.cost
  if (price(c?.input) && price(c?.output)) {
    out.cost = { input: c.input, output: c.output }
    if (price(c.cache_read)) out.cost.cacheRead = c.cache_read
    if (price(c.cache_write)) out.cost.cacheWrite = c.cache_write
    if (price(c.fast?.input) && price(c.fast?.output)) {
      out.cost.fast = { input: c.fast.input, output: c.fast.output }
      if (price(c.fast.cache_read)) out.cost.fast.cacheRead = c.fast.cache_read
      if (price(c.fast.cache_write)) out.cost.fast.cacheWrite = c.fast.cache_write
      if (positive(c.fast.maxInputTokens)) out.cost.fast.maxInputTokens = c.fast.maxInputTokens
    }
  }
  return Object.keys(out).length ? out : undefined
}

function toCatalogVendor(raw: unknown): CatalogVendor | undefined {
  if (
    !isObject(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.npm !== "string" ||
    !Array.isArray(raw.env) ||
    !raw.env.every((v: unknown) => typeof v === "string")
  ) {
    return undefined
  }
  return {
    id: raw.id,
    name: raw.name,
    env: [...raw.env],
    npm: raw.npm,
    ...(typeof raw.api === "string" ? { api: raw.api } : {}),
    ...(typeof raw.doc === "string" ? { doc: raw.doc } : {}),
  }
}

type TrimmedProvider = Partial<CatalogVendor> & { models: Record<string, Raw> }

/** Keeps only the fields the catalog reads, so the cached copy stays small. */
export function trimModelsDev(data: unknown): Record<string, TrimmedProvider> | undefined {
  if (!isObject(data)) return undefined
  const out: Record<string, TrimmedProvider> = {}
  for (const [pid, p] of Object.entries(data)) {
    if (!isObject(p) || !isObject(p.models)) continue
    const models: Record<string, Raw> = {}
    for (const [mid, m] of Object.entries(p.models as Raw)) {
      if (!isObject(m)) continue
      const { input, output, cache_read, cache_write } = isObject(m.cost) ? m.cost : ({} as Raw)
      models[mid] = {
        limit: m.limit,
        tool_call: m.tool_call,
        reasoning: m.reasoning,
        modalities: { input: m.modalities?.input },
        ...(isObject(m.cost)
          ? {
              cost: { input, output, cache_read, cache_write, ...(m.cost.fast ? { fast: m.cost.fast } : {}) },
            }
          : {}),
        ...(m.fast !== undefined ? { fast: m.fast } : {}),
        ...(m.tags !== undefined ? { tags: m.tags } : {}),
        ...(m.service_tiers !== undefined ? { service_tiers: m.service_tiers } : {}),
      }
    }
    const metadata: Raw = {}
    for (const field of ["id", "name", "env", "npm", "api", "doc"]) {
      if (Object.hasOwn(p, field)) metadata[field] = p[field]
    }
    out[pid] = { ...metadata, models }
  }
  return Object.keys(out).length ? out : undefined
}

function isObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0
const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
