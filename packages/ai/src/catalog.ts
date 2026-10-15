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
