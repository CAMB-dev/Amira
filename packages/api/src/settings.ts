import type { ModelOverrides, ProviderCompat, ReasoningEffort } from "@amira/ai"
import type { Budget } from "./subagents.ts"

export type ShellMode = "auto" | "bash" | "powershell"

export type EditingTool = "edit" | "apply_patch" | "both"

/** The source layer of a setting supplied to the host. */
export type SettingsLayerScope = "user" | "project" | "project-local" | "flags"

/** One explicit value of a setting, in the order the host applies its layers. */
export interface SettingsLayer<T = unknown> {
  scope: SettingsLayerScope
  /** The settings file, or `--flags` for command-line values. */
  file: string
  value: T
}

/** Provenance for the top-level settings keys. Missing keys have no entries. */
export type SettingsLayers = Partial<Record<keyof Settings, readonly SettingsLayer[]>>

/** Merged settings plus the explicit values that produced each top-level key. */
export interface SettingsView extends Readonly<Settings> {
  layers<K extends keyof Settings>(key: K): readonly SettingsLayer<NonNullable<Settings[K]>>[]
}

export interface ModelSettings extends ModelOverrides {
  /** Overrides the top-level thinking effort for this exact model id; --thinking wins. */
  thinking?: ReasoningEffort
  /** Overrides the provider's editing tools for this exact model id. */
  tools?: { edit?: EditingTool }
}

/**
 * A provider in settings.json (D54). Amira has none built in, so an entry needs `dialect` (the
 * protocol: openai-chat, openai-responses, anthropic-messages or google-gemini) and `baseUrl`;
 * both are optional here only because project files may add to a user entry.
 */
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
  /** Editing tools for this provider (DEFAULT_EDITING_TOOL). write remains available. */
  tools?: { edit?: EditingTool }
  models?: ModelSettings[]
  defaultModel?: ModelOverrides
}

/**
 * Merged settings (D35): CLI flags, then <cwd>/.amira/settings.local.json,
 * <cwd>/.amira/settings.json and ~/.amira/settings.json. Objects merge key by key; arrays
 * are replaced.
 */
export interface Settings {
  /** File-tool rewind; see DEFAULT_FILE_REWIND_* in settings-defaults.ts. */
  fileRewind?: { enabled?: boolean; maxFileBytes?: number; quotaBytes?: number }
  /** Default model as "provider/model". */
  model?: string
  /** Reasoning effort for thinking models; "default" explicitly leaves effort to the server. */
  thinking?: ReasoningEffort | "default"
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
  /**
   * Compaction (D19): `threshold` is the share of the context window that triggers it (DEFAULT_COMPACT_THRESHOLD),
   * `model` writes text summaries (default the session's model). `layout` places a
   * server-side checkpoint (providers.<id>.compat.compaction): "tail" (see DEFAULT_COMPACT_LAYOUT)
   * keeps the last turns verbatim after it; "recent-user" compacts everything and puts the
   * most recent user messages (up to about 64k tokens) before it, as Codex does. Text
   * summaries always use "tail". A set `model`, like /compact with instructions, always
   * writes a text summary.
   */
  compact?: { threshold?: number; model?: string; layout?: "tail" | "recent-user" }
  /** What the model is sent of the session's history, besides compaction (see ContextSettings). */
  context?: ContextSettings
  /** Generate a short name in the background after the first turn. See DEFAULT_AUTO_TITLE. */
  sessions?: { autoTitle?: boolean }
  /**
   * Retrying failed model requests (D52): retries after the first try, backoff, Retry-After and
   * content/idle timeouts in milliseconds.
   */
  retry?: {
    attempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    firstContentTimeoutMs?: number
    idleTimeoutMs?: number
    /** Native compaction deadline in milliseconds. See DEFAULT_NATIVE_COMPACTION_TIMEOUT_MS; 0 disables it. */
    nativeCompactionTimeoutMs?: number
  }
  /** MCP servers by name (D64). Their shape belongs to the MCP extension. */
  mcpServers?: Record<string, Record<string, unknown>>
  /**
   * Settings of extensions installed as packages, by extension name, e.g.
   * `{"swarm": {"confirm": false}, "workflow": {"enabled": "always"}}`. Their shape belongs
   * to each extension, which reads its own section and checks it.
   */
  extensions?: Record<string, Record<string, unknown>>
  /** Project directories whose own MCP servers may run; honoured in the user settings only. */
  mcpTrustedProjects?: string[]
  /** Installed extension packages (D24, D60). */
  packages?: PackageSettings
  skills?: { dirs?: string[] }
  /** The web_search and web_fetch tools. Hide them with tools.disabled. */
  web?: WebSettings
  /** Per sub-agent role (D61): the model it runs on, ahead of the role file's. */
  agents?: Record<string, { model?: string }>
  /**
   * Nesting depth (D15, DEFAULT_SUBAGENT_MAX_DEPTH) and children running at once in the
   * whole agent tree (D63, DEFAULT_SUBAGENT_MAX_CONCURRENT).
   * `background` (DEFAULT_SUBAGENT_BACKGROUND): the main session's `agent` tool runs sub-agents in the
   * background unless the call says otherwise; their results come back as a message.
   */
  subagents?: { maxDepth?: number; maxConcurrent?: number; background?: boolean }
  /**
   * Commands the shell tools run in the background (`background: true`), such as dev servers
   * and watchers. `maxRunning`: jobs running at once. `bufferChars`: output each job keeps in
   * memory for reading; `maxLogBytes`: how much goes to its log file.
   * See DEFAULT_BACKGROUND_* in settings-defaults.ts.
   */
  backgroundJobs?: { maxRunning?: number; bufferChars?: number; maxLogBytes?: number; printWaitMs?: number }
  /** A limit for the whole agent tree (D37); unlimited by default. */
  budget?: Budget
  /** Worktree merges (D38): clean merges past either size are reviewed too. Default: only conflicts. */
  merge?: { reviewThreshold?: { lines?: number; files?: number } }
  /** The interactive terminal UI. */
  tui?: TuiSettings
  /**
   * The core permission policy: the mode and the command rules. A project file can only
   * tighten them (see PermissionSettings).
   */
  permissions?: PermissionSettings
}

/**
 * How much the model may do without asking: "plan" is read-only (no file changes, no shell
 * commands), "edits" changes files without asking and asks before shell commands, "auto"
 * (see DEFAULT_PERMISSION_MODE) asks about nothing beyond the rules and protected paths.
 */
export type PermissionMode = "plan" | "edits" | "auto"

/** What a rule says about a command: run it without asking, ask first, or never run it. */
export type PermissionDecision = "allow" | "ask" | "deny"

/**
 * A rule for shell commands, matched against the words of each command (argv), not its text:
 * `{"command": ["git", "push"], "decision": "ask"}`. When several rules match, deny wins over
 * ask and ask over allow. `allow` only means "do not ask"; it never lifts the mode or a
 * protected path.
 */
export interface CommandRule {
  command: string[]
  decision: PermissionDecision
  /** Shown with the question or the refusal. */
  reason?: string
}

export interface PermissionSettings {
  /**
   * The mode a session starts in (DEFAULT_PERMISSION_MODE); Shift+Tab cycles it in the TUI and
   * --permission-mode wins. A project file can choose a stricter mode, never a looser one.
   */
  mode?: PermissionMode
  /**
   * Command rules. The user file's and the project files' rules all apply; a project's
   * `allow` rules only once the project is trusted (`amira ext trust`).
   */
  rules?: CommandRule[]
}

/**
 * Context management (all optional; defaults in settings-defaults.ts). The session file always keeps
 * everything; these only change what requests carry.
 */
export interface ContextSettings {
  outputs?: {
    /** Tool output longer than this many characters is saved as an artifact (DEFAULT_SAVE_ABOVE). */
    saveAbove?: number
    /** Characters of the preview the model gets for it instead (DEFAULT_PREVIEW_CHARS). */
    previewChars?: number
    /** Most megabytes of artifacts one session keeps; past it outputs are only previewed (DEFAULT_ARTIFACT_QUOTA_MB). */
    quotaMB?: number
  }
  /**
   * A read that returns exactly what an earlier read of the same range, still in context,
   * returned is sent as a short note pointing to it (DEFAULT_DEDUPE_READS).
   */
  dedupeReads?: boolean
  /**
   * Replacing old tool results with short stubs when the context gets full, before compaction.
   * Only for models whose history may be rewritten (no signed reasoning after the result).
   */
  aging?: {
    /** See DEFAULT_AGING_ENABLED. */
    enabled?: boolean
    /** Share of the context window that starts it (DEFAULT_AGING_START). */
    start?: number
    /** Share of the window it frees down to (DEFAULT_AGING_TARGET). */
    target?: number
    /** Skipped unless it frees at least this many tokens at once (DEFAULT_AGING_MIN_SAVED_TOKENS). */
    minSavedTokens?: number
    /** Most recent user turns never touched (DEFAULT_AGING_KEEP_TURNS). */
    keepTurns?: number
    /** In a long turn, most recent model steps never touched (DEFAULT_AGING_KEEP_STEPS). */
    keepSteps?: number
    /** Experimental: also stub results older than this many user turns, whatever the pressure. 0 is off (DEFAULT_AGING_AFTER_TURNS). */
    afterTurns?: number
  }
}

export interface PackageSettings {
  /**
   * Packages not to load, by name, of either scope; the lock files keep them. Set by
   * `amira ext disable|enable <name>`; `--no-packages` leaves out every package for one run.
   * Honoured in the user settings only.
   */
  disabled?: string[]
  /**
   * Project directories whose own packages (<dir>/.amira/packages) may load, and ones the user
   * chose not to load: asked the first time a project has packages. Honoured in the user
   * settings only.
   */
  trustedProjects?: string[]
  untrustedProjects?: string[]
}

export interface TuiSettings {
  /**
   * "fullscreen" keeps the conversation on the alternate screen, scrolled and searched by
   * Amira, and prints it to the normal screen on exit; "inline" leaves finished output in the
   * terminal's own scrollback (for SSH, tmux, or native scrolling and copying). See
   * DEFAULT_TUI_MODE; the --inline and --fullscreen flags win.
   */
  mode?: "fullscreen" | "inline"
  /**
   * A theme name, or "auto" for Amira following the terminal background (dark if unknown).
   * "dark" and "light" choose Amira explicitly; "terminal" uses the terminal's ANSI colors.
   * See DEFAULT_TUI_THEME.
   */
  theme?: string
  /** Named themes follow the background by default; force an appearance with dark or light. */
  themeVariant?: "auto" | "dark" | "light"
  /**
   * "auto" detects terminal color support; "truecolor", "256" and "16" override the color
   * depth. See DEFAULT_TUI_COLOR_DEPTH.
   */
  colorDepth?: "auto" | "truecolor" | "256" | "16"
  /**
   * Ring the bell when a turn ends or a dialog opens while the terminal is in the background
   * (or, where the terminal does not report focus, after a long turn). See DEFAULT_TUI_BELL.
   */
  bell?: boolean
  /** Set the terminal title to the folder, session title when present, and branch, marked while working. See DEFAULT_TUI_TITLE. */
  title?: boolean
  /** Show work on the tab and taskbar progress indicator (OSC 9;4). See DEFAULT_TUI_PROGRESS. */
  progress?: boolean
  /** Show live token speed and thinking time in the status bar. See DEFAULT_TUI_TOKEN_SPEED. */
  tokenSpeed?: boolean
  /**
   * Whether the terminal re-wraps lines when it gets narrower. "off" for terminals that do not
   * (legacy conhost with wrap-on-resize off, some tmux setups). See DEFAULT_TUI_REFLOW.
   */
  reflow?: "auto" | "on" | "off"
  /**
   * What plain Enter does while a turn runs: "steer" sends the message into the running turn,
   * "queue" sends it after the turn. The queue key does the other. See DEFAULT_TUI_SUBMIT_WHILE_WORKING.
   */
  submitWhileWorking?: "steer" | "queue"
  /**
   * Draw images that stand on a line of their own in replies (local files, and http(s) URLs
   * fetched like web_fetch does): "auto" where the terminal says it can (Sixel, kitty graphics,
   * iTerm2 inline images; VS Code with terminal.integrated.enableImages), "on" everywhere, "off"
   * never. Otherwise, and until one loads, an image shows as its alt text. See DEFAULT_TUI_IMAGES.
   */
  images?: "auto" | "on" | "off"
  /**
   * How many of its last output lines a shell command that succeeded shows under its result
   * (the tool output level "summary"; "full" shows all). 0 shows none. See DEFAULT_SHELL_OUTPUT_LINES.
   */
  shellOutputLines?: number
}

export type WebSearchBackend = "exa" | "brave" | "tavily" | "searxng"

/**
 * Keys that choose where requests go or which key they carry (the backends' url and apiKeyEnv,
 * fetch.allowPrivateNetwork) are only taken from the user file.
 */
export interface WebSettings {
  /**
   * false: never use a provider's hosted web search (providers.<id>.compat.webSearch), so
   * every model gets the web_search tool. See DEFAULT_WEB_NATIVE_SEARCH.
   */
  nativeSearch?: boolean
  search?: {
    /** See DEFAULT_WEB_SEARCH_BACKEND (Exa's hosted MCP server, no key needed). */
    backend?: WebSearchBackend
    /** Backends tried in order when the one before fails. Default none. */
    fallback?: WebSearchBackend[]
    /** Results returned when the call does not say. See DEFAULT_WEB_SEARCH_MAX_RESULTS. */
    maxResults?: number
    /** Per-backend request timeout. See DEFAULT_WEB_SEARCH_TIMEOUT_MS. */
    timeoutMs?: number
    /** url: DEFAULT_EXA_URL; apiKeyEnv (optional) raises the free rate limit. */
    exa?: { url?: string; apiKeyEnv?: string }
    /** apiKeyEnv: DEFAULT_BRAVE_API_KEY_ENV. */
    brave?: { apiKeyEnv?: string }
    /** apiKeyEnv: DEFAULT_TAVILY_API_KEY_ENV; searchDepth: DEFAULT_TAVILY_SEARCH_DEPTH. */
    tavily?: { apiKeyEnv?: string; searchDepth?: "basic" | "advanced" }
    /** url of a SearXNG instance with the JSON format enabled; required for this backend. */
    searxng?: { url?: string }
  }
  fetch?: {
    /** Characters of converted text returned per call. See DEFAULT_WEB_FETCH_MAX_CHARS. */
    maxChars?: number
    /** Largest response body read. See DEFAULT_WEB_FETCH_MAX_BYTES. */
    maxBytes?: number
    /** See DEFAULT_WEB_FETCH_TIMEOUT_MS. */
    timeoutMs?: number
    /** Allow localhost and private-network addresses. See DEFAULT_WEB_FETCH_ALLOW_PRIVATE_NETWORK. */
    allowPrivateNetwork?: boolean
  }
}
