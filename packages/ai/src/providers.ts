import type { CatalogModel } from "./catalog.ts"
import type { ProviderCompat } from "./dialect.ts"
import { defaultWebSearch } from "./server-tools.ts"
import type { ContextWindowSource, ModelCaps, ModelInfo } from "./types.ts"

/** Model settings a provider overrides; caps are merged key by key over the defaults. */
export type ModelOverrides = Partial<Omit<ModelInfo, "caps">> & { caps?: Partial<ModelCaps> }

/** A provider is configuration: where to connect and which dialect it speaks. */
export interface ProviderConfig {
  id: string
  dialect: string
  baseUrl: string
  /** Environment variable holding the API key. */
  apiKeyEnv?: string
  /** Variables tried in order when apiKeyEnv is unset. */
  apiKeyEnvFallbacks?: string[]
  apiKey?: string
  headers?: Record<string, string>
  compat?: ProviderCompat
  /**
   * The model catalog's id for this provider (models.dev), or false to not use the catalog.
   * Defaults to CATALOG_PROVIDER_IDS, then to the provider id. A catalog matching neither
   * supplies metadata only; it does not add models to the provider's offered model list.
   */
  catalogId?: string | false
  /** Known models. Unlisted models get defaultModel values. */
  models?: ModelOverrides[]
  defaultModel?: ModelOverrides
}

export const DEFAULT_CAPS: ModelCaps = {
  tools: "native",
  images: false,
  thinking: false,
  promptCache: false,
  parallelToolCalls: true,
}

/**
 * The model while no provider is configured or none was picked. Its empty provider matches
 * no configured one, so stream() explains what to do instead of sending a request.
 */
export const NO_MODEL: ModelInfo = {
  id: "",
  provider: "",
  dialect: "",
  contextWindow: 128_000,
  maxOutput: 8_192,
  caps: DEFAULT_CAPS,
}

/** Whether a model is the NO_MODEL placeholder (any model without a provider). */
export function isNoModel(model: Pick<ModelInfo, "provider">): boolean {
  return model.provider === ""
}

/**
 * A model's settings. A model the provider lists wins over the catalog, which wins over the
 * provider's defaultModel (meant for models nobody described), which wins over built-in defaults.
 */
export function resolveModelInfo(
  provider: ProviderConfig,
  modelId: string,
  catalog?: CatalogModel,
): ModelInfo {
  const known = provider.models?.find((m) => m.id === modelId)
  const d = provider.defaultModel
  const cost = known?.cost ?? catalog?.cost ?? d?.cost
  const window: [number, ContextWindowSource] =
    known?.contextWindow !== undefined
      ? [known.contextWindow, "settings"]
      : catalog?.contextWindow !== undefined
        ? [catalog.contextWindow, "catalog"]
        : d?.contextWindow !== undefined
          ? [d.contextWindow, "settings"]
          : [128_000, "default"]
  const dialect = known?.dialect ?? d?.dialect ?? provider.dialect
  const caps: ModelCaps = { ...DEFAULT_CAPS, ...d?.caps, ...catalog?.caps, ...known?.caps }
  // Hosted web search: the model's caps, then the provider's compat, then on only at the vendor.
  if (
    caps.webSearch === undefined &&
    (provider.compat?.webSearch ?? defaultWebSearch(dialect, provider.baseUrl))
  ) {
    caps.webSearch = true
  }
  return {
    id: modelId,
    provider: provider.id,
    dialect,
    contextWindow: window[0],
    contextWindowSource: window[1],
    maxOutput: known?.maxOutput ?? catalog?.maxOutput ?? d?.maxOutput ?? 8_192,
    caps,
    ...(cost ? { cost } : {}),
  }
}
