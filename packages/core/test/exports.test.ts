import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import {
  ArtifactStore,
  type ArtifactStoreOptions,
  EventBus,
  type FormEditor,
  type ListFiles,
  type ListOptions,
  type LocalConversationBinding,
  listProjectFiles,
  MAX_FILES,
  type SessionEntry,
  type SessionEntryData,
  type SessionHeader,
  SessionStore,
  type SpawnedSubagent,
  type SubagentEntry,
  streamProjectFiles,
  ToolRegistry,
} from "../src/index.ts"
import { usageReceiptDestination } from "../src/owned-conversations-receipts.ts"

test("finished subagent public types carry an opaque accounting destination, not a transcript", () => {
  const store = SessionStore.create({ cwd: process.cwd(), dir: tmpdir() })
  const identity: Pick<SpawnedSubagent, "accountingDestination"> &
    Pick<SubagentEntry, "accountingDestination"> = {
    accountingDestination: usageReceiptDestination(store),
  }
  expect({
    fields: Object.keys(identity),
    digest: /^[a-f0-9]{64}$/.test(identity.accountingDestination ?? ""),
  }).toMatchInlineSnapshot(`
    {
      "digest": true,
      "fields": [
        "accountingDestination",
      ],
    }
  `)
})

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

test("owned lifecycle headers and lease-held lifecycle writes remain explicit host-library contracts", () => {
  const header: SessionHeader = {
    type: "session-lifecycle",
    v: 3,
    id: "s_owned",
    cwd: "/workspace",
    parent: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    owned: {
      v: 3,
      owner: "project",
      spec: {
        key: "design",
        name: "Design",
        cwd: "/workspace",
        model: "mock/test",
        systemPrompt: "",
        callableTools: [],
      },
      runtimeTools: [],
    },
  }
  expect({
    type: header.type,
    version: header.v,
    ownedVersion: header.owned?.v,
    lifecycleWrite: typeof SessionStore.prototype.withOwnedLifecycleWrite,
    lifecycleOpen: typeof SessionStore.openOwnedLifecycle,
  }).toMatchInlineSnapshot(`
    {
      "lifecycleOpen": "function",
      "lifecycleWrite": "function",
      "ownedVersion": 3,
      "type": "session-lifecycle",
      "version": 3,
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

test("accounting evidence remains serializable through the public core session types", () => {
  const receipt: SessionEntry = {
    id: "receipt",
    parentId: null,
    ts: 1,
    type: "side_usage",
    model: { provider: "mock", model: "test" },
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, pricingUnknown: true },
    attribution: { sessionId: "private", parentSessionId: "owned", groupId: "group", ephemeral: true },
    accounting: {
      knownCostUsd: 0.25,
      incomplete: true,
      coverageIncomplete: true,
      receiptId: "native-attempt",
      coverage: { v: 1, reported: true, priced: false, fingerprint: "receipt-proof" },
      source: "request",
      attempts: [{ id: "physical-attempt", revision: 2 }],
      statements: [
        {
          v: 1,
          id: "logical-contribution",
          revision: 2,
          kind: "snapshot",
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, pricingUnknown: true },
          knownCostUsd: 0.25,
          coverage: { v: 1, reported: true, priced: false, fingerprint: "statement-proof" },
          attempts: [{ id: "physical-attempt", revision: 2 }],
        },
      ],
      seal: "record-proof",
      journal: { v: 1, sessionId: "owned", fingerprint: "journal-proof" },
    },
  }
  const child: SessionEntryData = {
    type: "subagent",
    childSessionId: "child",
    role: "worker",
    groupId: "group",
  }
  expect({ receipt, child }).toMatchInlineSnapshot(`
    {
      "child": {
        "childSessionId": "child",
        "groupId": "group",
        "role": "worker",
        "type": "subagent",
      },
      "receipt": {
        "accounting": {
          "attempts": [
            {
              "id": "physical-attempt",
              "revision": 2,
            },
          ],
          "coverage": {
            "fingerprint": "receipt-proof",
            "priced": false,
            "reported": true,
            "v": 1,
          },
          "coverageIncomplete": true,
          "incomplete": true,
          "journal": {
            "fingerprint": "journal-proof",
            "sessionId": "owned",
            "v": 1,
          },
          "knownCostUsd": 0.25,
          "receiptId": "native-attempt",
          "seal": "record-proof",
          "source": "request",
          "statements": [
            {
              "attempts": [
                {
                  "id": "physical-attempt",
                  "revision": 2,
                },
              ],
              "coverage": {
                "fingerprint": "statement-proof",
                "priced": false,
                "reported": true,
                "v": 1,
              },
              "id": "logical-contribution",
              "kind": "snapshot",
              "knownCostUsd": 0.25,
              "revision": 2,
              "usage": {
                "cacheRead": 0,
                "cacheWrite": 0,
                "input": 1,
                "output": 0,
                "pricingUnknown": true,
              },
              "v": 1,
            },
          ],
        },
        "attribution": {
          "ephemeral": true,
          "groupId": "group",
          "parentSessionId": "owned",
          "sessionId": "private",
        },
        "id": "receipt",
        "model": {
          "model": "test",
          "provider": "mock",
        },
        "parentId": null,
        "ts": 1,
        "type": "side_usage",
        "usage": {
          "cacheRead": 0,
          "cacheWrite": 0,
          "input": 1,
          "output": 0,
          "pricingUnknown": true,
        },
      },
    }
  `)
})

test("historical session inspection is an explicit structural-only open option", () => {
  const options: Parameters<typeof SessionStore.open>[1] = { historical: true }
  expect(options).toMatchInlineSnapshot(`
    {
      "historical": true,
    }
  `)
})

test("artifact stores require an independent trusted storage root", () => {
  const options: ArtifactStoreOptions = {
    dir: "/sessions/s.assets/outputs",
    storageRoot: "/sessions",
    sessionId: "s",
  }
  expect(options).toMatchInlineSnapshot(`
    {
      "dir": "/sessions/s.assets/outputs",
      "sessionId": "s",
      "storageRoot": "/sessions",
    }
  `)
})

test("project file listing functions and options are host-library exports", () => {
  const options: ListOptions = { limit: MAX_FILES, timeoutMs: 15_000 }
  const list: ListFiles = (cwd, emit, signal) => streamProjectFiles(cwd, emit, { ...options, signal })
  expect({ options, list: typeof list, collect: typeof listProjectFiles }).toMatchInlineSnapshot(`
    {
      "collect": "function",
      "list": "function",
      "options": {
        "limit": 250000,
        "timeoutMs": 15000,
      },
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
    "MAX_FILES",
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
    "listProjectFiles",
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
    "streamProjectFiles",
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

test("EventBus host capture is additive without changing extension event types", () => {
  const bus = new EventBus()
  const release = bus.capture(
    () => {},
    () => {},
  )
  expect({ capture: typeof bus.capture, release: typeof release }).toMatchInlineSnapshot(`
    {
      "capture": "function",
      "release": "function",
    }
  `)
  release()
})

test("ArtifactStore exports host-only pinned read authority without changing OutputStore", () => {
  const resolveOwned: (id: string) => Promise<{ path: string; root: string } | undefined> =
    ArtifactStore.prototype.resolveOwned
  expect({ resolveOwned: typeof resolveOwned }).toEqual({ resolveOwned: "function" })
})
