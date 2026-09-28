import type { ModelOverrides, ProviderCompat } from "@amira/ai"
import type { Budget } from "./subagents.ts"

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
  /**
   * Slash command aliases: `{"ds": "model deepseek/deepseek-flash"}` makes `/ds` run that line,
   * with anything typed after `/ds` appended. The value names a command, not another alias.
   * Commands and the aliases they declare win over these.
   */
  commandAliases?: Record<string, string>
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
  /** Per sub-agent role (D61): the model it runs on, ahead of the role file's. */
  agents?: Record<string, { model?: string }>
  /** Nesting depth (D15, default 2) and children running at once per parent (D63, default 4). */
  subagents?: { maxDepth?: number; maxConcurrent?: number }
  /** A limit for the whole agent tree (D37); unlimited by default. */
  budget?: Budget
  /** Worktree merges (D38): clean merges past either size are reviewed too. Default: only conflicts. */
  merge?: { reviewThreshold?: { lines?: number; files?: number } }
  /** The interactive terminal UI. */
  tui?: TuiSettings
}

export interface TuiSettings {
  /**
   * Ring the bell when a turn ends or a dialog opens while the terminal is in the background
   * (or, where the terminal does not report focus, after a long turn). Default true.
   */
  bell?: boolean
  /** Set the terminal title to the folder and branch, marked while working. Default true. */
  title?: boolean
  /** Show work on the tab and taskbar progress indicator (OSC 9;4). Default true. */
  progress?: boolean
  /**
   * Whether the terminal re-wraps lines when it gets narrower. "off" for terminals that do not
   * (legacy conhost with wrap-on-resize off, some tmux setups). Default "auto" (assumes it does).
   */
  reflow?: "auto" | "on" | "off"
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
