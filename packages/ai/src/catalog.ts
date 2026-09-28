import type { ModelCaps, ModelInfo } from "./types.ts"

/** What the catalog knows about one model; every field is optional. */
export interface CatalogModel {
  contextWindow?: number
  maxOutput?: number
  caps?: Partial<ModelCaps>
  cost?: NonNullable<ModelInfo["cost"]>
}

/** Model facts by catalog provider id and model id (D51). */
export interface ModelCatalog {
  find(catalogProvider: string, modelId: string): CatalogModel | undefined
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
  const id = p.catalogId ?? CATALOG_PROVIDER_IDS[p.id] ?? p.id
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
      if (!mapped.has(key)) mapped.set(key, toCatalogModel(lookup(models, modelId)))
      return mapped.get(key)
    },
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
  }
  return Object.keys(out).length ? out : undefined
}

/** Keeps only the fields the catalog reads, so the cached copy stays small. */
export function trimModelsDev(data: unknown): Record<string, { models: Record<string, Raw> }> | undefined {
  if (!isObject(data)) return undefined
  const out: Record<string, { models: Record<string, Raw> }> = {}
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
        ...(isObject(m.cost) ? { cost: { input, output, cache_read, cache_write } } : {}),
      }
    }
    out[pid] = { models }
  }
  return Object.keys(out).length ? out : undefined
}

function isObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0
const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
