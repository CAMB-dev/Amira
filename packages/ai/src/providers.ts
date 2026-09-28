import type { CatalogModel } from "./catalog.ts"
import type { ProviderCompat } from "./dialect.ts"
import type { ModelCaps, ModelInfo } from "./types.ts"

/** Model settings a provider overrides; caps are merged key by key over the defaults. */
export type ModelOverrides = Partial<Omit<ModelInfo, "caps">> & { caps?: Partial<ModelCaps> }

/** A provider is configuration: where to connect and which dialect it speaks. */
export interface ProviderConfig {
  id: string
  dialect: string
  baseUrl: string
  /** Environment variable holding the API key. */
  apiKeyEnv?: string
  apiKey?: string
  headers?: Record<string, string>
  compat?: ProviderCompat
  /**
   * The model catalog's id for this provider (models.dev), or false to not use the catalog.
   * Defaults to CATALOG_PROVIDER_IDS, then to the provider id.
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

/** OpenAI-compatible services that work with the openai-chat dialect out of the box. */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: "openai",
    dialect: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    // o-series and gpt-5 models reject max_tokens.
    compat: { maxTokensField: "max_completion_tokens" },
  },
  {
    id: "deepseek",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "openrouter",
    dialect: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  { id: "ollama", dialect: "openai-chat", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", dialect: "openai-chat", baseUrl: "http://localhost:1234/v1" },
]

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
  return {
    id: modelId,
    provider: provider.id,
    dialect: known?.dialect ?? d?.dialect ?? provider.dialect,
    contextWindow: known?.contextWindow ?? catalog?.contextWindow ?? d?.contextWindow ?? 128_000,
    maxOutput: known?.maxOutput ?? catalog?.maxOutput ?? d?.maxOutput ?? 8_192,
    caps: { ...DEFAULT_CAPS, ...d?.caps, ...catalog?.caps, ...known?.caps },
    ...(cost ? { cost } : {}),
  }
}
