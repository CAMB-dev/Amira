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
  /** Variables tried in order when apiKeyEnv is unset. */
  apiKeyEnvFallbacks?: string[]
  apiKey?: string
  headers?: Record<string, string>
  compat?: ProviderCompat
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
 * Providers available without configuration (D53). Others, such as DeepSeek or a local
 * server, are added in settings.json; PROVIDER_PRESETS has ready-made entries for them.
 */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: "anthropic",
    dialect: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: { caps: { promptCache: true, thinking: true } },
  },
  {
    id: "openai",
    dialect: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "openai-chat",
    dialect: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    // o-series and gpt-5 models reject max_tokens.
    compat: { maxTokensField: "max_completion_tokens" },
  },
  {
    id: "google",
    dialect: "google-gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    apiKeyEnvFallbacks: ["GOOGLE_API_KEY"],
  },
]

export function resolveModelInfo(provider: ProviderConfig, modelId: string): ModelInfo {
  const known = provider.models?.find((m) => m.id === modelId)
  const d = provider.defaultModel
  return {
    id: modelId,
    provider: provider.id,
    dialect: known?.dialect ?? d?.dialect ?? provider.dialect,
    contextWindow: known?.contextWindow ?? d?.contextWindow ?? 128_000,
    maxOutput: known?.maxOutput ?? d?.maxOutput ?? 8_192,
    caps: { ...DEFAULT_CAPS, ...d?.caps, ...known?.caps },
    ...((known?.cost ?? d?.cost) ? { cost: known?.cost ?? d?.cost } : {}),
  }
}
