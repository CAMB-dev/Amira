import { expect, test } from "bun:test"
import {
  type FormEditor,
  type LocalConversationBinding,
  type SessionHeader,
  ToolRegistry,
} from "../src/index.ts"

test("policy-bearing session header types remain exported with an explicit format discriminator", () => {
  const header: SessionHeader = {
    type: "session-policy",
    v: 2,
    id: "s_bounded",
    cwd: "/workspace",
    parent: null,
    createdAt: "2026-10-15T00:00:00.000Z",
    writeRoots: [],
  }
  expect(header).toMatchInlineSnapshot(`
    {
      "createdAt": "2026-10-15T00:00:00.000Z",
      "cwd": "/workspace",
      "id": "s_bounded",
      "parent": null,
      "type": "session-policy",
      "v": 2,
      "writeRoots": [],
    }
  `)
})

test("form editor identity and resumed revision remain host-library exports", () => {
  const editor: FormEditor = { editor: "editor-1", revision: 7 }
  expect(editor).toMatchInlineSnapshot(`
    {
      "editor": "editor-1",
      "revision": 7,
    }
  `)
})

test("local conversation bindings retain callable cleanup and host-issued incarnation metadata", () => {
  let released = false
  const binding: LocalConversationBinding = Object.assign(
    () => {
      released = true
    },
    { incarnation: "host-token" },
  )
  expect(binding.incarnation).toMatchInlineSnapshot(`"host-token"`)
  binding()
  expect(released).toBe(true)
})

test("tool enablement can check captured capabilities without changing the registration identity", () => {
  const tools = new ToolRegistry()
  const tool = {
    name: "monitor",
    description: "",
    parameters: {},
    traits: { shell: "powershell" as const },
    execute: async () => ({ content: [] }),
  }
  tools.register(tool, "test")
  tools.setPolicy({ shell: "powershell" })
  expect({
    live: tools.isEnabled(tool),
    captured: tools.isEnabled(tool, { traits: { shell: "bash" } }),
  }).toMatchInlineSnapshot(`
    {
      "captured": false,
      "live": true,
    }
  `)
})

test("the public core exports stay stable", async () => {
  const actual = Object.keys(await import("../src/index.ts")).sort()
  expect(actual).toEqual([
    "AGING_DEFAULTS",
    "Agent",
    "AgentAbortedError",
    "AgentBusyError",
    "AgentTree",
    "ArtifactQuotaError",
    "ArtifactStore",
    "BUILTIN_VIEW_KINDS",
    "CommandConflictError",
    "CommandHost",
    "CommandRegistry",
    "DEFAULT_ARTIFACT_QUOTA_MB",
    "DEFAULT_SETTINGS",
    "EventBus",
    "ExtensionBackgroundJobs",
    "ExtensionHost",
    "FAILURE_POLICY",
    "FILE_REWIND_COVERAGE",
    "FileRewind",
    "FileRewindConflictError",
    "FrontendOperationError",
    "INSTRUCTION_FILES",
    "ImageProviderRegistry",
    "InputRegistry",
    "InterceptorRegistry",
    "KEEP_USER_TOKENS",
    "LockBusyError",
    "MODE_SUMMARY",
    "MarkdownRendererRegistry",
    "NON_INTERACTIVE_LINE",
    "NOTICE_RETRY_MS",
    "OwnedConversationManager",
    "PERMISSION_MODES",
    "PanelRegistry",
    "Permissions",
    "ProviderSettingsError",
    "SECTION_ORDER",
    "SESSION_LOCK_HEARTBEAT_MS",
    "SESSION_LOCK_STALE_MS",
    "SHIMMER_PRESETS",
    "ServiceRegistry",
    "SessionBackgroundJobHost",
    "SessionConflictError",
    "SessionInUseError",
    "SessionStore",
    "SettingsError",
    "SkillConflictError",
    "SkillRegistry",
    "SpawnError",
    "StatusConflictError",
    "StatusRegistry",
    "SummaryError",
    "TOOL_SEARCH",
    "ThemeRegistry",
    "ToolConflictError",
    "ToolRegistry",
    "ToolRendererRegistry",
    "TraceRecorder",
    "UiRequests",
    "ViewRegistry",
    "addNonInteractive",
    "addProviderToSettings",
    "agedStub",
    "agingCandidates",
    "amiraHome",
    "amiraPath",
    "artifactDir",
    "artifactIdsIn",
    "askTitle",
    "authFile",
    "bindLocalCommandContext",
    "bindLocalConversation",
    "builtinWrittenPaths",
    "checkArgs",
    "checkpointOf",
    "commandAliasWarnings",
    "commandName",
    "contextTokens",
    "copyFileHistory",
    "createLocalAgentPort",
    "createToolSession",
    "createUiFormBackend",
    "deepMerge",
    "defaultSections",
    "deferredToolsSection",
    "deleteSession",
    "duplicateView",
    "estimateAfter",
    "estimateTokens",
    "fileCompactionMemory",
    "fileHistoryDir",
    "findSession",
    "forkHistory",
    "frontendIdentity",
    "fuzzyScore",
    "gitInfo",
    "hooksPathsIn",
    "installVirtualApi",
    "instructionsSection",
    "intermediate",
    "isCommandAliasName",
    "isFrontendError",
    "isProcessAlive",
    "isSummaryMessage",
    "isWrapper",
    "lastSealedIndex",
    "listSessions",
    "listSubagents",
    "loadAuth",
    "loadInstructions",
    "loadSettings",
    "newSessionId",
    "newTurnId",
    "normalizeShimmer",
    "offeredTools",
    "pairCalls",
    "parseBash",
    "parseCommandLine",
    "parseParentAnswers",
    "parsePowerShell",
    "parseSkillLine",
    "projectAmiraDir",
    "projectKey",
    "projectMessages",
    "protectedPath",
    "providersFromSettings",
    "rankMatches",
    "readJsonFile",
    "readTrace",
    "recentUserMessages",
    "referencedArtifacts",
    "renderPrompt",
    "renderTranscript",
    "resolvePermissions",
    "resolveShimmer",
    "restrictToCurrentUser",
    "resultText",
    "ruleLabel",
    "ruleMatches",
    "runExtensionCommand",
    "sessionLockFile",
    "sessionLockPid",
    "sessionSnippet",
    "sessionsDir",
    "setAuthKey",
    "setSection",
    "settingsFiles",
    "splitHistory",
    "storedHistory",
    "stricterMode",
    "strictest",
    "subagentMessages",
    "subagentSessionFiles",
    "subagentsOf",
    "summarize",
    "summaryMessages",
    "summaryOf",
    "toolPath",
    "toolTraits",
    "trackWorkspace",
    "tryFileLock",
    "updateProviderInSettings",
    "updateSettingsFile",
    "usageTokens",
    "validateAuth",
    "validateSettings",
    "validateValue",
    "waitFileLock",
    "windowGuessNotice",
    "writtenPaths",
  ])
})
