import { expect, test } from "bun:test"
import type {
  AgentStatusSource,
  CommandContext,
  EventMap,
  ExtensionAPI,
  ExtensionView,
  PanelRenderOptions,
  PrintOptions,
  ShimmerColors,
  ShimmerEffect,
  ShimmerOptions,
  ShimmerPreset,
  ShimmerStyle,
  SpawnOptions,
  ThemeDefinition,
  ToolLine,
  ToolResult,
  ToolResultMessage,
  TuiSettings,
} from "../src/index.ts"

test("the public API exports stay stable", async () => {
  const api = await import("../src/index.ts")
  const actual = Object.keys(api).sort()
  expect(api.API_VERSION).toBe("0.1.50")
  expect(actual).toEqual([
    "AGENT_STATUS_BADGES",
    "API_VERSION",
    "ARTIFACT_HEADER",
    "DEFAULT_AGING_AFTER_TURNS",
    "DEFAULT_AGING_ENABLED",
    "DEFAULT_AGING_KEEP_STEPS",
    "DEFAULT_AGING_KEEP_TURNS",
    "DEFAULT_AGING_MIN_SAVED_TOKENS",
    "DEFAULT_AGING_START",
    "DEFAULT_AGING_TARGET",
    "DEFAULT_ARTIFACT_QUOTA_MB",
    "DEFAULT_AUTO_TITLE",
    "DEFAULT_BACKGROUND_BUFFER_CHARS",
    "DEFAULT_BACKGROUND_MAX_LOG_BYTES",
    "DEFAULT_BACKGROUND_MAX_RUNNING",
    "DEFAULT_BACKGROUND_PRINT_WAIT_MS",
    "DEFAULT_BRAVE_API_KEY_ENV",
    "DEFAULT_COMPACT_LAYOUT",
    "DEFAULT_COMPACT_THRESHOLD",
    "DEFAULT_CONTEXT_WINDOW",
    "DEFAULT_DEDUPE_READS",
    "DEFAULT_DISABLED_TOOLS",
    "DEFAULT_EDITING_TOOL",
    "DEFAULT_EXA_URL",
    "DEFAULT_FILE_REWIND_ENABLED",
    "DEFAULT_FILE_REWIND_MAX_FILE_BYTES",
    "DEFAULT_FILE_REWIND_QUOTA_BYTES",
    "DEFAULT_FIRST_CONTENT_TIMEOUT_MS",
    "DEFAULT_IDLE_TIMEOUT_MS",
    "DEFAULT_MAX_OUTPUT",
    "DEFAULT_MAX_PARALLEL_TOOLS",
    "DEFAULT_MAX_TOKENS_FIELD",
    "DEFAULT_MCP_ARGS",
    "DEFAULT_MCP_DISABLED",
    "DEFAULT_MCP_TRUSTED_PROJECTS",
    "DEFAULT_MODEL_IMAGES",
    "DEFAULT_MODEL_PARALLEL_TOOL_CALLS",
    "DEFAULT_MODEL_PROMPT_CACHE",
    "DEFAULT_MODEL_THINKING",
    "DEFAULT_MODEL_TOOLS",
    "DEFAULT_NATIVE_COMPACTION",
    "DEFAULT_NATIVE_COMPACTION_TIMEOUT_MS",
    "DEFAULT_PACKAGES_DISABLED",
    "DEFAULT_PACKAGES_TRUSTED_PROJECTS",
    "DEFAULT_PACKAGES_UNTRUSTED_PROJECTS",
    "DEFAULT_PERMISSION_MODE",
    "DEFAULT_PERMISSION_RULES",
    "DEFAULT_PREVIEW_CHARS",
    "DEFAULT_RETRY_ATTEMPTS",
    "DEFAULT_RETRY_BASE_DELAY_MS",
    "DEFAULT_RETRY_MAX_DELAY_MS",
    "DEFAULT_SAVE_ABOVE",
    "DEFAULT_SHELL",
    "DEFAULT_SHELL_OUTPUT_LINES",
    "DEFAULT_STREAM_USAGE",
    "DEFAULT_SUBAGENT_BACKGROUND",
    "DEFAULT_SUBAGENT_MAX_CONCURRENT",
    "DEFAULT_SUBAGENT_MAX_DEPTH",
    "DEFAULT_TAVILY_API_KEY_ENV",
    "DEFAULT_TAVILY_SEARCH_DEPTH",
    "DEFAULT_THEME_GLYPHS",
    "DEFAULT_THINKING_MODE",
    "DEFAULT_TUI_BELL",
    "DEFAULT_TUI_COLOR_DEPTH",
    "DEFAULT_TUI_IMAGES",
    "DEFAULT_TUI_MARGIN",
    "DEFAULT_TUI_MARGIN_ROWS",
    "DEFAULT_TUI_MODE",
    "DEFAULT_TUI_NOTIFY",
    "DEFAULT_TUI_PROGRESS",
    "DEFAULT_TUI_REFLOW",
    "DEFAULT_TUI_SUBMIT_WHILE_WORKING",
    "DEFAULT_TUI_THEME",
    "DEFAULT_TUI_THEME_VARIANT",
    "DEFAULT_TUI_TITLE",
    "DEFAULT_TUI_TOKEN_SPEED",
    "DEFAULT_WEB_FETCH_ALLOW_PRIVATE_NETWORK",
    "DEFAULT_WEB_FETCH_MAX_BYTES",
    "DEFAULT_WEB_FETCH_MAX_CHARS",
    "DEFAULT_WEB_FETCH_TIMEOUT_MS",
    "DEFAULT_WEB_NATIVE_SEARCH",
    "DEFAULT_WEB_SEARCH_BACKEND",
    "DEFAULT_WEB_SEARCH_MAX_RESULTS",
    "DEFAULT_WEB_SEARCH_TIMEOUT_MS",
    "DIALECT_NOTES",
    "MAX_ARTIFACT_CHARS",
    "MAX_TITLE_CHARS",
    "NetError",
    "OMITTED_NOTE",
    "PANEL_MAX_LINES",
    "PROVIDER_SEARCH",
    "RETURN_RESULT_TOOL",
    "THEME_PALETTE_TOKENS",
    "TRACE_VERSION",
    "UNSAVED_HEADER",
    "USER_STOP_REASON",
    "addUsage",
    "agentStatusState",
    "artifactIdOf",
    "autoFormActions",
    "checkForm",
    "clip",
    "clipMiddle",
    "countLines",
    "defineExtension",
    "definePackageCommand",
    "defineTool",
    "describeFormErrors",
    "diffToolLines",
    "draftFromValues",
    "emptyUsage",
    "extensionSettingsDefaults",
    "fallbackTitle",
    "fetchPublic",
    "fieldDefault",
    "formDefaults",
    "formatDuration",
    "formatElapsed",
    "formatTokens",
    "guardedFetch",
    "hasUnpricedSearch",
    "hostBackgroundJobs",
    "hostPrepareCommand",
    "hostRunCommand",
    "hostWarmUpCommands",
    "installHostNet",
    "installHostProcess",
    "isFieldVisible",
    "isHostStandbyGoneError",
    "isPrivateAddress",
    "isSubagentView",
    "modelDescription",
    "modelLabel",
    "openPipe",
    "outputPreview",
    "outputSize",
    "padCells",
    "parseHttpUrl",
    "plural",
    "previewNoteLine",
    "providerFormSpec",
    "providerVendorInitial",
    "providerVendorLabel",
    "readCapped",
    "runFormAction",
    "runFormDialogs",
    "secretFieldIds",
    "sectionOf",
    "serverToolText",
    "serverToolView",
    "subagentStateText",
    "summarizeTrace",
    "textCells",
    "textResult",
    "toFormSchema",
    "tokenWeight",
    "toolResultText",
    "validateExtensionSetting",
    "withSection",
  ])
})

test("the public display-state source contract handles clean stops and pauses without a version bump", async () => {
  const api = await import("../src/index.ts")
  const sources: AgentStatusSource[] = [
    { status: "done", note: "" },
    { startedAt: 1, paused: true },
  ]
  const terminal: "done" | "failed" | "stopped" = api.agentStatusState({ status: "done", note: "" })
  expect({
    version: api.API_VERSION,
    terminal,
    states: sources.map((source) => api.agentStatusState(source)),
  }).toMatchInlineSnapshot(`
    {
      "states": [
        "stopped",
        "paused",
      ],
      "terminal": "stopped",
      "version": "0.1.50",
    }
  `)
})

test("the public unload hook contract is additive without a version bump", () => {
  const hooks = new Set<() => void>()
  const lifecycle: Pick<ExtensionAPI, "onUnload"> = {
    onUnload: (hook) => {
      hooks.add(hook)
      return () => void hooks.delete(hook)
    },
  }
  const off = lifecycle.onUnload(() => {})
  expect({
    methods: Object.keys(lifecycle),
    registered: hooks.size,
    disposer: typeof off,
  }).toMatchInlineSnapshot(`
    {
      "disposer": "function",
      "methods": [
        "onUnload",
      ],
      "registered": 1,
    }
  `)
  off()
  expect(hooks.size).toBe(0)
})

test("the public side-question API contract is additive without a version bump", () => {
  const spawn: SpawnOptions = {
    prompt: "side question",
    context: "fork",
    ephemeral: true,
    callableTools: ["read", "grep", "glob"],
  }
  const view: ExtensionView = { kind: "btw", placement: "dock", maxHeight: 12 }
  const options: PrintOptions = { details: "side answer", markdown: true, persist: true }
  const output: unknown[] = []
  const print: CommandContext["print"] = (text, level, opts) => {
    output.push({ text, level, options: opts })
  }
  print("btw: question", "info", options)
  expect({ spawn, view, output }).toMatchInlineSnapshot(`
    {
      "output": [
        {
          "level": "info",
          "options": {
            "details": "side answer",
            "markdown": true,
            "persist": true,
          },
          "text": "btw: question",
        },
      ],
      "spawn": {
        "callableTools": [
          "read",
          "grep",
          "glob",
        ],
        "context": "fork",
        "ephemeral": true,
        "prompt": "side question",
      },
      "view": {
        "kind": "btw",
        "maxHeight": 12,
        "placement": "dock",
      },
    }
  `)
})

test("the additive provider-stream event contract preserves optional timing metadata", () => {
  const events: EventMap["message.stream"][] = [
    { kind: "request" },
    { kind: "request", thinkingDisplay: "summarized" },
    { kind: "contentStart" },
    { kind: "thinkingStart", index: 0 },
    { kind: "thinkingEnd", index: 0 },
    { kind: "end", outputTokens: 856 },
  ]
  expect(events).toMatchInlineSnapshot(`
    [
      {
        "kind": "request",
      },
      {
        "kind": "request",
        "thinkingDisplay": "summarized",
      },
      {
        "kind": "contentStart",
      },
      {
        "index": 0,
        "kind": "thinkingStart",
      },
      {
        "index": 0,
        "kind": "thinkingEnd",
      },
      {
        "kind": "end",
        "outputTokens": 856,
      },
    ]
  `)
})

test("the public TUI settings include optional margins without changing API_VERSION", async () => {
  const { API_VERSION, DEFAULT_TUI_MARGIN, DEFAULT_TUI_MARGIN_ROWS } = await import("../src/index.ts")
  const defaults: TuiSettings = { margin: DEFAULT_TUI_MARGIN, marginRows: DEFAULT_TUI_MARGIN_ROWS }
  const edgeToEdge: TuiSettings = { margin: 0, marginRows: 0 }
  const omitted: TuiSettings = {}
  expect(API_VERSION).toBe("0.1.50")
  expect(defaults).toEqual({ margin: 3, marginRows: 1 })
  expect(edgeToEdge).toEqual({ margin: 0, marginRows: 0 })
  expect(omitted).toEqual({})
})

test("the public shimmer types are shared by theme definitions and TUI settings", () => {
  const preset: ShimmerPreset = "soft"
  const style: ShimmerStyle = "sweep"
  const colors: ShimmerColors = { dark: ["#123", "#456"], light: ["#ABC", "#DEF"] }
  const options: ShimmerOptions = {
    preset,
    style,
    colors,
    width: 6,
    period: 1800,
    edge: "soft",
    direction: "ltr",
  }
  const effect: ShimmerEffect = options
  const theme: ThemeDefinition = { name: "animated", shimmerEffect: effect }
  const settings: TuiSettings = { shimmer: effect }
  expect(theme.shimmerEffect).toBe(settings.shimmer)
  expect(effect).toMatchInlineSnapshot(`
    {
      "colors": {
        "dark": [
          "#123",
          "#456",
        ],
        "light": [
          "#ABC",
          "#DEF",
        ],
      },
      "direction": "ltr",
      "edge": "soft",
      "period": 1800,
      "preset": "soft",
      "style": "sweep",
      "width": 6,
    }
  `)
  const alias: ShimmerEffect = { preset: "sweep", edge: "linear" }
  expect(alias).toEqual({ preset: "sweep", edge: "linear" })
})

test("presenter choices and opt-in durable details are public additive contracts", () => {
  const line: ToolLine = {
    kind: "text",
    text: "Patch",
    marker: "success",
    description: "Fix it in place",
    wrap: true,
  }
  const result: ToolResult = { content: [], details: { selected: ["Patch"] }, persistDetails: true }
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "ask_user",
    content: [],
    isError: false,
    details: result.details,
  }
  expect({ line, result, message }).toMatchInlineSnapshot(`
    {
      "line": {
        "description": "Fix it in place",
        "kind": "text",
        "marker": "success",
        "text": "Patch",
        "wrap": true,
      },
      "message": {
        "content": [],
        "details": {
          "selected": [
            "Patch",
          ],
        },
        "isError": false,
        "role": "toolResult",
        "toolCallId": "c1",
        "toolName": "ask_user",
      },
      "result": {
        "content": [],
        "details": {
          "selected": [
            "Patch",
          ],
        },
        "persistDetails": true,
      },
    }
  `)
})

test("panels can reuse the frontend command spinner without requiring it from other hosts", () => {
  const options: PanelRenderOptions = { width: 80, now: 0, sessionId: "s1", collapsed: false }
  expect(options.spinner).toBeUndefined()
  options.spinner = "frame"
  expect(options.spinner).toBe("frame")
})

test("the canonical theme glyph export includes the layout symbols", async () => {
  const { DEFAULT_THEME_GLYPHS } = await import("../src/index.ts")
  expect(DEFAULT_THEME_GLYPHS).toMatchSnapshot()
})
