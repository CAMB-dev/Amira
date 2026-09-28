import type { ModelOverrides, ProviderCompat } from "@amira/ai"

export type ShellMode = "auto" | "bash" | "powershell"

/** A provider in settings.json; merged over a built-in provider of the same id (D54). */
export interface ProviderSettings {
  dialect?: string
  baseUrl?: string
  /** Environment variable holding the API key; auth.json is the fallback. */
  apiKeyEnv?: string
  /** Variables tried in order when apiKeyEnv is unset. */
  apiKeyEnvFallbacks?: string[]
  headers?: Record<string, string>
  compat?: ProviderCompat
  /** The model catalog's (models.dev) id for this provider, or false to not use the catalog (D51). */
  catalogId?: string | false
  models?: ModelOverrides[]
  defaultModel?: ModelOverrides
}

/**
 * Merged settings (D35): CLI flags, then <cwd>/.amira/settings.local.json,
 * <cwd>/.amira/settings.json and ~/.amira/settings.json. Objects merge key by key; arrays
 * are replaced.
 */
export interface Settings {
  /** Default model as "provider/model". */
  model?: string
  /** baseUrl, apiKeyEnv, apiKeyEnvFallbacks and headers are only taken from the user file. */
  providers?: Record<string, ProviderSettings>
  /** Which shell tools the model gets on Windows (D68). */
  shell?: ShellMode
  tools?: { disabled?: string[] }
  /** Most tool calls running at once (D71). */
  maxParallelTools?: number
  compact?: { threshold?: number; model?: string }
  /** Retrying failed model requests (D52): retries after the first try, first backoff, longest Retry-After waited. */
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number }
  /** MCP servers by name (D64). Their shape belongs to the MCP extension. */
  mcpServers?: Record<string, Record<string, unknown>>
  /** Project directories whose own MCP servers may run; honoured in the user settings only. */
  mcpTrustedProjects?: string[]
  skills?: { dirs?: string[] }
}
