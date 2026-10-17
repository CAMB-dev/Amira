import { expect, test } from "bun:test"
import type {
  ActionField,
  AgentStatusSource,
  BackgroundJobChange,
  BackgroundJobInfo,
  BackgroundJobStartOptions,
  CommandContext,
  ConversationRuntime,
  ConversationSpec,
  EventMap,
  ExtensionAPI,
  ExtensionView,
  FormFieldSchema,
  FormSchema,
  FormSpec,
  ModelSettings,
  OwnedConversation,
  OwnedConversations,
  PanelRenderOptions,
  PrintOptions,
  SessionControl,
  SessionInfo,
  Settings,
  ShimmerColors,
  ShimmerEffect,
  ShimmerOptions,
  ShimmerPreset,
  ShimmerStyle,
  SpawnOptions,
  ThemeDefinition,
  ToolContext,
  ToolLine,
  ToolResult,
  ToolResultMessage,
  TuiSettings,
  UiEvent,
  UiNode,
  UiRequest,
  UiRequestOptions,
  Usage,
} from "../src/index.ts"

test("monitor jobs add an optional kind to the public job contract", () => {
  const start: BackgroundJobStartOptions = {
    command: "watch",
    argv: ["watch"],
    cwd: "/work",
    kind: "monitor",
    onChange() {},
  }
  const output: Pick<BackgroundJobChange, "output"> = { output: "new chunk" }
  const kind: BackgroundJobInfo["kind"] = start.kind
  const ordinary: Pick<BackgroundJobInfo, "kind"> = {}
  const context: Pick<ToolContext, "shellKind" | "expectNotice"> = {
    shellKind: "bash",
    expectNotice: () => ({ deliver() {}, cancel() {} }),
  }
  expect({
    kind,
    ordinary,
    shell: context.shellKind,
    notices: typeof context.expectNotice,
    observer: typeof start.onChange,
    output: output.output,
  }).toMatchInlineSnapshot(`
    {
      "kind": "monitor",
      "notices": "function",
      "observer": "function",
      "ordinary": {},
      "output": "new chunk",
      "shell": "bash",
    }
  `)
})

test("the public agent settings allow an unlimited model-call limit", () => {
  const settings: Pick<Settings, "agent"> = { agent: { maxSteps: 0 } }
  expect(settings).toMatchInlineSnapshot(`
    {
      "agent": {
        "maxSteps": 0,
      },
    }
  `)
})

test("declarative buttons reuse the existing activation event without a version bump", async () => {
  const button: UiNode = { type: "button", id: "run", label: "Run", key: "execute", tone: "accent" }
  const fallback: UiNode = { type: "button", id: "close", label: "Close" }
  const event: UiEvent = { type: "activate", id: button.id, key: button.key ?? button.id }
  expect(event).toEqual({ type: "activate", id: "run", key: "execute" })
  expect(fallback.key ?? fallback.id).toBe("close")
  expect((await import("../src/index.ts")).API_VERSION).toBe("0.1.59")
})

test("card forms and footer action labels are additive public contracts without a version bump", async () => {
  const api = await import("../src/index.ts")
  const action: ActionField = {
    type: "action",
    id: "testConnection",
    label: "Test connection",
    placement: "footer",
    buttonLabel: "Test",
    run: async () => undefined,
  }
  const spec: FormSpec = { title: "Provider", layout: "card", fields: [action] }
  const schema: FormSchema = api.toFormSchema(spec)
  const field: FormFieldSchema = schema.fields[0]!
  expect({ version: api.API_VERSION, layout: schema.layout, field }).toMatchInlineSnapshot(`
    {
      "field": {
        "buttonLabel": "Test",
        "id": "testConnection",
        "label": "Test connection",
        "placement": "footer",
        "type": "action",
      },
      "layout": "card",
      "version": "0.1.59",
    }
  `)
})

test("the public API exports stay stable", async () => {
  const api = await import("../src/index.ts")
  const actual = Object.keys(api).sort()
  expect(api.API_VERSION).toBe("0.1.59")
  expect(actual).toEqual([
    "AGENT_STATUS_BADGES",
    "API_VERSION",
    "ARTIFACT_HEADER",
    "DEFAULT_AGENT_MAX_STEPS",
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
    "runFormBeforeSubmit",
    "runFormChange",
    "runFormDialogs",
    "secretFieldIds",
    "sectionOf",
    "serverToolText",
    "serverToolView",
    "subagentStateText",
    "subagentTranscriptText",
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

test("only the named transcript renderer is public, not its internal helpers", async () => {
  const api = await import("../src/index.ts")
  const internal = await import("@amira/api/internal/subagent-transcript")
  expect(
    Object.keys(internal)
      .filter((name) => name in api)
      .sort(),
  ).toMatchInlineSnapshot(`
    [
      "subagentTranscriptText",
    ]
  `)
  for (const name of [
    "callKids",
    "elapsed",
    "usageText",
    "subagentSummary",
    "subagentOwnMessages",
    "transcriptText",
  ])
    expect(name in api).toBe(false)
  expect(api.subagentTranscriptText).toBe(internal.subagentTranscriptText)
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
      "version": "0.1.59",
    }
  `)
})

test("the fast mode contract is additive without a version bump", () => {
  const settings: Pick<Settings, "fastMode"> = { fastMode: true }
  const state: Pick<SessionInfo, "fastMode"> = {
    fastMode: { requested: true, applied: true, used: "standard" },
  }
  const control: Pick<SessionControl, "setFastMode"> = {
    setFastMode: (enabled) => {
      settings.fastMode = enabled
    },
  }
  control.setFastMode(false)
  expect({ settings, state, methods: Object.keys(control) }).toMatchInlineSnapshot(`
    {
      "methods": [
        "setFastMode",
      ],
      "settings": {
        "fastMode": false,
      },
      "state": {
        "fastMode": {
          "applied": true,
          "requested": true,
          "used": "standard",
        },
      },
    }
  `)
})

test("provider-neutral fast options and served tiers remain additive", () => {
  const fast: ModelSettings["fast"] = { kind: "service-tier", value: "priority", textOnly: true }
  const usage: Pick<Usage, "serviceTier" | "pricingUnknown"> = {
    serviceTier: "priority",
    pricingUnknown: true,
  }
  const status: SessionInfo["fastMode"] = {
    requested: true,
    applied: true,
    used: "priority",
    pricingUnknown: true,
  }
  expect({ fast, usage, status }).toMatchInlineSnapshot(`
    {
      "fast": {
        "kind": "service-tier",
        "textOnly": true,
        "value": "priority",
      },
      "status": {
        "applied": true,
        "pricingUnknown": true,
        "requested": true,
        "used": "priority",
      },
      "usage": {
        "pricingUnknown": true,
        "serviceTier": "priority",
      },
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
  expect(API_VERSION).toBe("0.1.59")
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

test("native conversation focus, image sends and message display are additive public contracts", () => {
  const unsupported: Pick<CommandContext, "focusConversation" | "unfocusConversation"> = {}
  const supported: Pick<CommandContext, "focusConversation" | "unfocusConversation"> = {
    focusConversation: () => true,
    unfocusConversation: () => true,
  }
  const send: Parameters<OwnedConversation["send"]> = [
    "Describe this",
    {
      images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=", name: "diagram.png" }],
      display: { text: "Describe this [Image #1]" },
    },
  ]
  expect({
    unsupported,
    capabilities: Object.keys(supported),
    send,
    sendOptionKeys: Object.keys(send[1] ?? {}).sort(),
  }).toMatchInlineSnapshot(`
    {
      "capabilities": [
        "focusConversation",
        "unfocusConversation",
      ],
      "send": [
        "Describe this",
        {
          "display": {
            "text": "Describe this [Image #1]",
          },
          "images": [
            {
              "data": "aW1hZ2U=",
              "mimeType": "image/png",
              "name": "diagram.png",
              "type": "image",
            },
          ],
        },
      ],
      "sendOptionKeys": [
        "display",
        "images",
      ],
      "unsupported": {},
    }
  `)
})

test("conversation question association is an optional public display contract", () => {
  const options: UiRequestOptions = { sessionId: "owned-design" }
  const request: UiRequest = { kind: "ask", title: "Design?", questions: [], sessionId: options.sessionId }
  expect({ options, request }).toMatchInlineSnapshot(`
    {
      "options": {
        "sessionId": "owned-design",
      },
      "request": {
        "kind": "ask",
        "questions": [],
        "sessionId": "owned-design",
        "title": "Design?",
      },
    }
  `)
})

test("owned conversation types are public and the extension capability remains optional", async () => {
  const absent: Pick<ExtensionAPI, "conversations"> = {}
  const spec: ConversationSpec = {
    key: "notes/design",
    name: "Design",
    cwd: "/workspace",
    systemPrompt: "Research.",
    callableTools: ["read", "ask_user"],
  }
  const runtime: ConversationRuntime = {
    askUser: async (_questions, { sessionId, signal }) =>
      signal.aborted || !sessionId ? undefined : [{ selected: ["A"] }],
  }
  const state: ReturnType<OwnedConversation["status"]> = { state: "idle", busy: false }
  const capabilities: OwnedConversations = {
    openOrCreate: async (_spec, _runtime) => {
      throw new Error("fixture does not execute")
    },
    open: async (_id, _runtime) => {
      throw new Error("fixture does not execute")
    },
  }
  const present: Pick<ExtensionAPI, "conversations"> = { conversations: capabilities }
  expect(absent.conversations).toBeUndefined()
  expect(present.conversations).toBe(capabilities)
  expect(await runtime.askUser([], { sessionId: "owned", signal: new AbortController().signal })).toEqual([
    { selected: ["A"] },
  ])
  const bounded: ConversationSpec = { ...spec, writeRoots: ["/workspace/notes"], descendants: "inherit" }
  const spawn: SpawnOptions = { prompt: "Check notes", writeRoots: [] }
  const runTool: OwnedConversation["runTool"] = async (name, args, options) => ({
    content: [{ type: "text", text: `${name}: ${args.command}` }],
    isError: options?.signal?.aborted ?? false,
  })
  expect({
    writeRoots: bounded.writeRoots,
    descendants: bounded.descendants,
    childWriteRoots: spawn.writeRoots,
    result: await runTool("bash", { command: "echo check" }, { signal: new AbortController().signal }),
  }).toMatchInlineSnapshot(`
    {
      "childWriteRoots": [],
      "descendants": "inherit",
      "result": {
        "content": [
          {
            "text": "bash: echo check",
            "type": "text",
          },
        ],
        "isError": false,
      },
      "writeRoots": [
        "/workspace/notes",
      ],
    }
  `)
  expect({ spec, state }).toMatchInlineSnapshot(`
    {
      "spec": {
        "callableTools": [
          "read",
          "ask_user",
        ],
        "cwd": "/workspace",
        "key": "notes/design",
        "name": "Design",
        "systemPrompt": "Research.",
      },
      "state": {
        "busy": false,
        "state": "idle",
      },
    }
  `)
})
