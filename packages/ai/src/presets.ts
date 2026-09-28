import type { ProviderConfig } from "./providers.ts"

/** Ready-made configurations for providers that are not built in (D53, D54). */
export const PROVIDER_PRESETS: ProviderConfig[] = [
  {
    id: "deepseek",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "deepseek-anthropic",
    dialect: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    compat: { thinking: "budget" },
    defaultModel: { caps: { thinking: true, promptCache: true } },
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

export function findPreset(id: string): ProviderConfig | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}
