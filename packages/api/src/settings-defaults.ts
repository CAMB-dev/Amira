/**
 * Fixed settings fallbacks. Absence/inheritance (for example model and thinking) is not a
 * fixed value. Keep fallback application at each consumer: loading all defaults into Settings
 * would change merging, provenance and the distinction between omitted and explicit values.
 *
 * ai and proc cannot depend on api. Their package-local defaults are checked against these
 * constants by scripts/settings-docs.test.ts; do not add an upward dependency for them.
 */
export const DEFAULT_SHELL = "auto"
export const DEFAULT_DISABLED_TOOLS: readonly string[] = Object.freeze([])
export const DEFAULT_MAX_PARALLEL_TOOLS = 8
export const DEFAULT_BACKGROUND_MAX_RUNNING = 8
export const DEFAULT_BACKGROUND_BUFFER_CHARS = 1_000_000
export const DEFAULT_BACKGROUND_MAX_LOG_BYTES = 50 * 1024 * 1024
export const DEFAULT_BACKGROUND_PRINT_WAIT_MS = 30_000
export const DEFAULT_AUTO_TITLE = true
export const DEFAULT_PERMISSION_MODE = "auto"
export const DEFAULT_PERMISSION_RULES = Object.freeze([])

export const DEFAULT_MAX_TOKENS_FIELD = "max_tokens"
export const DEFAULT_STREAM_USAGE = true
export const DEFAULT_THINKING_MODE = "adaptive"
export const DEFAULT_NATIVE_COMPACTION = "auto"
export const DEFAULT_EDITING_TOOL = "edit"
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_OUTPUT = 8_192
export const DEFAULT_MODEL_TOOLS = "native"
export const DEFAULT_MODEL_IMAGES = false
export const DEFAULT_MODEL_THINKING = false
export const DEFAULT_MODEL_PROMPT_CACHE = false
export const DEFAULT_MODEL_PARALLEL_TOOL_CALLS = true

export const DEFAULT_COMPACT_THRESHOLD = 0.8
export const DEFAULT_COMPACT_LAYOUT = "tail"
export const DEFAULT_FILE_REWIND_ENABLED = true
export const DEFAULT_FILE_REWIND_MAX_FILE_BYTES = 10 * 1024 * 1024
export const DEFAULT_FILE_REWIND_QUOTA_BYTES = 256 * 1024 * 1024
export const DEFAULT_SAVE_ABOVE = 16_000
export const DEFAULT_PREVIEW_CHARS = 8_000
export const DEFAULT_ARTIFACT_QUOTA_MB = 256
export const DEFAULT_DEDUPE_READS = true
export const DEFAULT_AGING_ENABLED = true
export const DEFAULT_AGING_START = 0.7
export const DEFAULT_AGING_TARGET = 0.6
export const DEFAULT_AGING_MIN_SAVED_TOKENS = 8_000
export const DEFAULT_AGING_KEEP_TURNS = 2
export const DEFAULT_AGING_KEEP_STEPS = 2
export const DEFAULT_AGING_AFTER_TURNS = 0

export const DEFAULT_RETRY_ATTEMPTS = 3
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
export const DEFAULT_RETRY_MAX_DELAY_MS = 60_000
export const DEFAULT_FIRST_CONTENT_TIMEOUT_MS = 150_000
export const DEFAULT_IDLE_TIMEOUT_MS = 100_000
export const DEFAULT_NATIVE_COMPACTION_TIMEOUT_MS = 300_000

export const DEFAULT_WEB_NATIVE_SEARCH = true
export const DEFAULT_WEB_SEARCH_BACKEND = "exa"
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 8
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 20_000
export const DEFAULT_EXA_URL = "https://mcp.exa.ai/mcp"
export const DEFAULT_BRAVE_API_KEY_ENV = "BRAVE_API_KEY"
export const DEFAULT_TAVILY_API_KEY_ENV = "TAVILY_API_KEY"
export const DEFAULT_TAVILY_SEARCH_DEPTH = "basic"
export const DEFAULT_WEB_FETCH_MAX_CHARS = 20_000
export const DEFAULT_WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 30_000
export const DEFAULT_WEB_FETCH_ALLOW_PRIVATE_NETWORK = false

export const DEFAULT_SUBAGENT_MAX_DEPTH = 2
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 4
export const DEFAULT_SUBAGENT_BACKGROUND = true
export const DEFAULT_TUI_MODE = "fullscreen"
export const DEFAULT_TUI_THEME = "auto"
export const DEFAULT_TUI_THEME_VARIANT = "auto"
export const DEFAULT_TUI_COLOR_DEPTH = "auto"
export const DEFAULT_TUI_BELL = true
export const DEFAULT_TUI_NOTIFY = "auto"
export const DEFAULT_TUI_TITLE = true
export const DEFAULT_TUI_PROGRESS = true
export const DEFAULT_TUI_TOKEN_SPEED = true
export const DEFAULT_TUI_REFLOW = "auto"
export const DEFAULT_TUI_SUBMIT_WHILE_WORKING = "steer"
export const DEFAULT_TUI_IMAGES = "auto"
export const DEFAULT_SHELL_OUTPUT_LINES = 3

export const DEFAULT_MCP_ARGS: readonly string[] = Object.freeze([])
export const DEFAULT_MCP_DISABLED = false
export const DEFAULT_MCP_TRUSTED_PROJECTS: readonly string[] = Object.freeze([])
export const DEFAULT_PACKAGES_DISABLED: readonly string[] = Object.freeze([])
export const DEFAULT_PACKAGES_TRUSTED_PROJECTS: readonly string[] = Object.freeze([])
export const DEFAULT_PACKAGES_UNTRUSTED_PROJECTS: readonly string[] = Object.freeze([])
