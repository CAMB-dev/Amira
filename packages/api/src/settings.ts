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
  /** The web_search and web_fetch tools. Hide them with tools.disabled. */
  web?: WebSettings
}

export type WebSearchBackend = "exa" | "brave" | "tavily" | "searxng"

/**
 * Keys that choose where requests go or which key they carry (the backends' url and apiKeyEnv,
 * fetch.allowPrivateNetwork) are only taken from the user file.
 */
export interface WebSettings {
  search?: {
    /** Default "exa" (Exa's hosted MCP server, no key needed). */
    backend?: WebSearchBackend
    /** Backends tried in order when the one before fails. Default none. */
    fallback?: WebSearchBackend[]
    /** Results returned when the call does not say. Default 8. */
    maxResults?: number
    /** Per-backend request timeout. Default 20000. */
    timeoutMs?: number
    /** url default https://mcp.exa.ai/mcp; apiKeyEnv (optional) raises the free rate limit. */
    exa?: { url?: string; apiKeyEnv?: string }
    /** apiKeyEnv default BRAVE_API_KEY. */
    brave?: { apiKeyEnv?: string }
    /** apiKeyEnv default TAVILY_API_KEY; searchDepth default "basic". */
    tavily?: { apiKeyEnv?: string; searchDepth?: "basic" | "advanced" }
    /** url of a SearXNG instance with the JSON format enabled; required for this backend. */
    searxng?: { url?: string }
  }
  fetch?: {
    /** Characters of converted text returned per call. Default 20000. */
    maxChars?: number
    /** Largest response body read. Default 5 MB. */
    maxBytes?: number
    /** Default 30000. */
    timeoutMs?: number
    /** Allow localhost and private-network addresses. Default false. */
    allowPrivateNetwork?: boolean
  }
}
