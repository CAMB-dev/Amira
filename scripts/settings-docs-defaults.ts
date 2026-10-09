import * as d from "../packages/api/src/settings-defaults.ts"

/** Fixed fallbacks, keyed exactly as the settings reference. Inherited/unset values stay prose. */
export const settingsDefaults = {
  shell: d.DEFAULT_SHELL,
  "tools.disabled": d.DEFAULT_DISABLED_TOOLS,
  maxParallelTools: d.DEFAULT_MAX_PARALLEL_TOOLS,
  "backgroundJobs.maxRunning": d.DEFAULT_BACKGROUND_MAX_RUNNING,
  "backgroundJobs.bufferChars": d.DEFAULT_BACKGROUND_BUFFER_CHARS,
  "backgroundJobs.maxLogBytes": d.DEFAULT_BACKGROUND_MAX_LOG_BYTES,
  "backgroundJobs.printWaitMs": d.DEFAULT_BACKGROUND_PRINT_WAIT_MS,
  "sessions.autoTitle": d.DEFAULT_AUTO_TITLE,
  "permissions.mode": d.DEFAULT_PERMISSION_MODE,
  "permissions.rules": d.DEFAULT_PERMISSION_RULES,
  "providers.<id>.compat.maxTokensField": d.DEFAULT_MAX_TOKENS_FIELD,
  "providers.<id>.compat.streamUsage": d.DEFAULT_STREAM_USAGE,
  "providers.<id>.compat.thinking": d.DEFAULT_THINKING_MODE,
  "providers.<id>.compat.compaction": d.DEFAULT_NATIVE_COMPACTION,
  "providers.<id>.tools.edit": d.DEFAULT_EDITING_TOOL,
  "providers.<id>.models[].contextWindow": d.DEFAULT_CONTEXT_WINDOW,
  "providers.<id>.models[].maxOutput": d.DEFAULT_MAX_OUTPUT,
  "providers.<id>.models[].caps.tools": d.DEFAULT_MODEL_TOOLS,
  "providers.<id>.models[].caps.images": d.DEFAULT_MODEL_IMAGES,
  "providers.<id>.models[].caps.thinking": d.DEFAULT_MODEL_THINKING,
  "providers.<id>.models[].caps.promptCache": d.DEFAULT_MODEL_PROMPT_CACHE,
  "providers.<id>.models[].caps.parallelToolCalls": d.DEFAULT_MODEL_PARALLEL_TOOL_CALLS,
  "compact.threshold": d.DEFAULT_COMPACT_THRESHOLD,
  "compact.layout": d.DEFAULT_COMPACT_LAYOUT,
  "fileRewind.enabled": d.DEFAULT_FILE_REWIND_ENABLED,
  "fileRewind.maxFileBytes": d.DEFAULT_FILE_REWIND_MAX_FILE_BYTES,
  "fileRewind.quotaBytes": d.DEFAULT_FILE_REWIND_QUOTA_BYTES,
  "context.outputs.saveAbove": d.DEFAULT_SAVE_ABOVE,
  "context.outputs.previewChars": d.DEFAULT_PREVIEW_CHARS,
  "context.outputs.quotaMB": d.DEFAULT_ARTIFACT_QUOTA_MB,
  "context.dedupeReads": d.DEFAULT_DEDUPE_READS,
  "context.aging.enabled": d.DEFAULT_AGING_ENABLED,
  "context.aging.start": d.DEFAULT_AGING_START,
  "context.aging.target": d.DEFAULT_AGING_TARGET,
  "context.aging.minSavedTokens": d.DEFAULT_AGING_MIN_SAVED_TOKENS,
  "context.aging.keepTurns": d.DEFAULT_AGING_KEEP_TURNS,
  "context.aging.keepSteps": d.DEFAULT_AGING_KEEP_STEPS,
  "context.aging.afterTurns": d.DEFAULT_AGING_AFTER_TURNS,
  "retry.attempts": d.DEFAULT_RETRY_ATTEMPTS,
  "retry.baseDelayMs": d.DEFAULT_RETRY_BASE_DELAY_MS,
  "retry.maxDelayMs": d.DEFAULT_RETRY_MAX_DELAY_MS,
  "retry.firstContentTimeoutMs": d.DEFAULT_FIRST_CONTENT_TIMEOUT_MS,
  "retry.idleTimeoutMs": d.DEFAULT_IDLE_TIMEOUT_MS,
  "retry.nativeCompactionTimeoutMs": d.DEFAULT_NATIVE_COMPACTION_TIMEOUT_MS,
  "web.nativeSearch": d.DEFAULT_WEB_NATIVE_SEARCH,
  "web.search.backend": d.DEFAULT_WEB_SEARCH_BACKEND,
  "web.search.maxResults": d.DEFAULT_WEB_SEARCH_MAX_RESULTS,
  "web.search.timeoutMs": d.DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  "web.search.exa.url": d.DEFAULT_EXA_URL,
  "web.search.brave.apiKeyEnv": d.DEFAULT_BRAVE_API_KEY_ENV,
  "web.search.tavily.apiKeyEnv": d.DEFAULT_TAVILY_API_KEY_ENV,
  "web.search.tavily.searchDepth": d.DEFAULT_TAVILY_SEARCH_DEPTH,
  "web.fetch.maxChars": d.DEFAULT_WEB_FETCH_MAX_CHARS,
  "web.fetch.maxBytes": d.DEFAULT_WEB_FETCH_MAX_BYTES,
  "web.fetch.timeoutMs": d.DEFAULT_WEB_FETCH_TIMEOUT_MS,
  "web.fetch.allowPrivateNetwork": d.DEFAULT_WEB_FETCH_ALLOW_PRIVATE_NETWORK,
  "subagents.maxDepth": d.DEFAULT_SUBAGENT_MAX_DEPTH,
  "subagents.maxConcurrent": d.DEFAULT_SUBAGENT_MAX_CONCURRENT,
  "subagents.background": d.DEFAULT_SUBAGENT_BACKGROUND,
  "tui.mode": d.DEFAULT_TUI_MODE,
  "tui.bell": d.DEFAULT_TUI_BELL,
  "tui.title": d.DEFAULT_TUI_TITLE,
  "tui.progress": d.DEFAULT_TUI_PROGRESS,
  "tui.tokenSpeed": d.DEFAULT_TUI_TOKEN_SPEED,
  "tui.reflow": d.DEFAULT_TUI_REFLOW,
  "tui.submitWhileWorking": d.DEFAULT_TUI_SUBMIT_WHILE_WORKING,
  "tui.images": d.DEFAULT_TUI_IMAGES,
  "tui.shellOutputLines": d.DEFAULT_SHELL_OUTPUT_LINES,
  "mcpServers.<name>.args": d.DEFAULT_MCP_ARGS,
  "mcpServers.<name>.disabled": d.DEFAULT_MCP_DISABLED,
  mcpTrustedProjects: d.DEFAULT_MCP_TRUSTED_PROJECTS,
  "packages.disabled": d.DEFAULT_PACKAGES_DISABLED,
  "packages.trustedProjects": d.DEFAULT_PACKAGES_TRUSTED_PROJECTS,
  "packages.untrustedProjects": d.DEFAULT_PACKAGES_UNTRUSTED_PROJECTS,
}

export type DefaultKey = keyof typeof settingsDefaults

/** Unit hints are derived too, so changing a timeout cannot leave a stale parenthetical. */
export function documentedDefault(key: DefaultKey): string | { en: string; zh: string } {
  const value = settingsDefaults[key]
  const code = `\`${JSON.stringify(value)}\``
  switch (key) {
    case "backgroundJobs.maxLogBytes":
    case "web.fetch.maxBytes":
      return `${code} (${Number(value) / 1024 / 1024} MiB)`
    case "backgroundJobs.printWaitMs":
    case "retry.firstContentTimeoutMs":
    case "retry.idleTimeoutMs":
      return `${code} (${Number(value) / 1000} s)`
    case "retry.nativeCompactionTimeoutMs":
      return {
        en: `${code} (${Number(value) / 60_000} minutes)`,
        zh: `${code}（${Number(value) / 60_000} 分钟）`,
      }
    case "providers.<id>.models[].contextWindow":
    case "providers.<id>.models[].maxOutput":
      return { en: `catalog, else ${code}`, zh: `取模型目录，否则为 ${code}` }
    case "web.search.exa.url":
    case "web.search.brave.apiKeyEnv":
    case "web.search.tavily.apiKeyEnv":
      return `\`${value}\``
    default:
      return code
  }
}
