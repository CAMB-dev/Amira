import type { ProviderCompat } from "./dialect.ts"
import type { ModelCaps, ModelInfo } from "./types.ts"

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
  /** Known models. Unlisted models get defaultModel values. */
  models?: Partial<ModelInfo>[]
  defaultModel?: Partial<Omit<ModelInfo, "caps">> & { caps?: Partial<ModelCaps> }
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
