import { expect, test } from "bun:test"
import {
  ArtifactStore,
  type ArtifactStoreOptions,
  EventBus,
  type SessionEntry,
  type SessionEntryData,
  type SessionHeader,
  SessionStore,
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

test("owned lifecycle headers and lease-held lifecycle writes remain explicit core contracts", () => {
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

test("session entry types remain serializable through the public core session types", () => {
  const receipt: SessionEntry = {
    id: "receipt",
    parentId: null,
    ts: 1,
    type: "side_usage",
    model: { provider: "mock", model: "test" },
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, pricingUnknown: true },
    attribution: { sessionId: "private", parentSessionId: "owned", groupId: "group", ephemeral: true },
    accounting: { knownCostUsd: 0.25, incomplete: true },
  }
  const child: SessionEntryData = {
    type: "subagent",
    childSessionId: "child",
    role: "worker",
    groupId: "group",
  }
  expect(receipt.type).toBe("side_usage")
  expect(child.type).toBe("subagent")
})

test("historical session inspection is an explicit structural-only open option", () => {
  const options: Parameters<typeof SessionStore.open>[1] = { historical: true }
  expect(options).toEqual({ historical: true })
})

test("artifact stores require an independent trusted storage root", () => {
  const options: ArtifactStoreOptions = {
    dir: "/sessions/s.assets/outputs",
    storageRoot: "/sessions",
    sessionId: "s",
  }
  expect(options).toEqual({
    dir: "/sessions/s.assets/outputs",
    sessionId: "s",
    storageRoot: "/sessions",
  })
})

test("the public core exports stay stable", async () => {
  const actual = Object.keys(await import("../src/index.ts")).sort()
  expect(actual).toEqual(
    [
      "AGING_DEFAULTS",
      "Agent",
      "AgentAbortedError",
      "AgentBusyError",
      "ArtifactQuotaError",
      "ArtifactStore",
      "DEFAULT_ARTIFACT_QUOTA_MB",
      "EventBus",
      "FAILURE_POLICY",
      "FILE_REWIND_COVERAGE",
      "FileRewind",
      "FileRewindConflictError",
      "InterceptorRegistry",
      "KEEP_USER_TOKENS",
      "LockBusyError",
      "MODE_SUMMARY",
      "NON_INTERACTIVE_LINE",
      "NOTICE_RETRY_MS",
      "NetError",
      "PERMISSION_MODES",
      "Permissions",
      "SECTION_ORDER",
      "SESSION_LOCK_HEARTBEAT_MS",
      "SESSION_LOCK_STALE_MS",
      "SessionConflictError",
      "SessionInUseError",
      "SessionStore",
      "SummaryError",
      "TOOL_SEARCH",
      "ToolConflictError",
      "ToolRegistry",
      "USER_AGENT",
      "addNonInteractive",
      "agedStub",
      "agingCandidates",
      "amiraHome",
      "amiraPath",
      "artifactDir",
      "artifactIdsIn",
      "assertPublicHost",
      "builtinWrittenPaths",
      "checkArgs",
      "checkpointOf",
      "commandName",
      "contextTokens",
      "copyFileHistory",
      "createToolSession",
      "defaultSections",
      "deferredToolsSection",
      "dnsResolver",
      "duplicateView",
      "estimateAfter",
      "estimateTokens",
      "fetchPublic",
      "fileCompactionMemory",
      "fileHistoryDir",
      "guardedFetch",
      "hooksPathsIn",
      "intermediate",
      "isPrivateAddress",
      "isProcessAlive",
      "isSummaryMessage",
      "isWrapper",
      "lastSealedIndex",
      "newSessionId",
      "newTurnId",
      "offeredTools",
      "pairCalls",
      "parseBash",
      "parsePowerShell",
      "parseHttpUrl",
      "projectAmiraDir",
      "projectKey",
      "projectMessages",
      "protectedPath",
      "readCapped",
      "recentUserMessages",
      "referencedArtifacts",
      "renderPrompt",
      "renderTranscript",
      "resolvePermissions",
      "resultText",
      "ruleLabel",
      "ruleMatches",
      "sessionLockFile",
      "sessionLockPid",
      "sessionsDir",
      "setSection",
      "setUserAgentVersion",
      "splitHistory",
      "stricterMode",
      "strictest",
      "subagentSessionFiles",
      "summarize",
      "summaryMessages",
      "summaryOf",
      "toolPath",
      "toolTraits",
      "tryFileLock",
      "validateValue",
      "waitFileLock",
      "windowGuessNotice",
      "writeAtomicFile",
      "writtenPaths",
    ].sort(),
  )
})

test("EventBus host capture is additive without changing extension event types", () => {
  const bus = new EventBus()
  const release = bus.capture(
    () => {},
    () => {},
  )
  expect({ capture: typeof bus.capture, release: typeof release }).toEqual({
    capture: "function",
    release: "function",
  })
  release()
})

test("ArtifactStore exports host-only pinned read authority without changing OutputStore", () => {
  const resolveOwned: (id: string) => Promise<{ path: string; root: string } | undefined> =
    ArtifactStore.prototype.resolveOwned
  expect({ resolveOwned: typeof resolveOwned }).toEqual({ resolveOwned: "function" })
})
