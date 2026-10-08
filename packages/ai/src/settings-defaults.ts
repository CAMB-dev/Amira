// This package cannot depend on api. scripts/settings-docs.test.ts checks these against
// the central settings defaults in @amira/api.
export const DEFAULT_MAX_TOKENS_FIELD = "max_tokens"
export const DEFAULT_STREAM_USAGE = true
export const DEFAULT_THINKING_MODE = "adaptive"
export const DEFAULT_NATIVE_COMPACTION = "auto"
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_OUTPUT = 8_192
export const DEFAULT_MODEL_TOOLS = "native"
export const DEFAULT_MODEL_IMAGES = false
export const DEFAULT_MODEL_THINKING = false
export const DEFAULT_MODEL_PROMPT_CACHE = false
export const DEFAULT_MODEL_PARALLEL_TOOL_CALLS = true
export const DEFAULT_RETRY_ATTEMPTS = 3
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
export const DEFAULT_RETRY_MAX_DELAY_MS = 60_000
export const DEFAULT_FIRST_CONTENT_TIMEOUT_MS = 150_000
export const DEFAULT_IDLE_TIMEOUT_MS = 100_000
export const DEFAULT_NATIVE_COMPACTION_TIMEOUT_MS = 300_000
