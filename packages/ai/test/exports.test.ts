import { expect, test } from "bun:test"
import type { UsageCounts } from "@amira/ai-shared"
import type { Ai, CompactReceipt, ModelRequest, StreamEvent } from "../src/index.ts"

test("local-only request approval and resolution helpers have an explicit package subpath", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(pkg.exports).toEqual({
    ".": "./src/index.ts",
    "./accounting": "./src/accounting.ts",
    "./local": "./src/local.ts",
  })
  expect(Object.keys(await import("@amira/ai/local")).sort()).toEqual([
    "resolvedEndpointCredentials",
    "withAiRequestBoundary",
  ])
})

test("model requests can forbid tool calls without dropping definitions", () => {
  const request: Pick<ModelRequest, "toolChoice" | "tools"> = { toolChoice: "none", tools: [] }
  expect(request).toMatchInlineSnapshot(`
    {
      "toolChoice": "none",
      "tools": [],
    }
  `)
})

test("the public ai exports stay stable", async () => {
  const actual = Object.keys(await import("../src/index.ts")).sort()
  expect(actual).toEqual([
    "ANTHROPIC_VERSION",
    "BUILTIN_DIALECTS",
    "CATALOG_PROVIDER_IDS",
    "CompactionFailures",
    "DEFAULT_CAPS",
    "FORGET_FAILURE_MS",
    "IDLE_TIMEOUT_HINT",
    "INVALID_ARGS_KEY",
    "LISTABLE_DIALECTS",
    "NATIVE_WEB_SEARCH",
    "NO_MODEL",
    "ProbeError",
    "TextToolParser",
    "adaptThinking",
    "addUsage",
    "anthropicMessages",
    "canReplay",
    "canReplayBlock",
    "canReplayServerTool",
    "catalogProviderId",
    "collect",
    "createAi",
    "createCatalog",
    "createMockDialect",
    "defaultWebSearch",
    "describeModelError",
    "describeServerTool",
    "emptyUsage",
    "endpointKey",
    "forReplay",
    "geminiBody",
    "googleGemini",
    "hasFastMode",
    "hasNativeWebSearch",
    "hasUnpricedSearch",
    "host",
    "invalidArgs",
    "isContextOverflow",
    "isGemini3",
    "isNoModel",
    "isOpenAIVendorUrl",
    "isUnsupportedCompaction",
    "listModels",
    "messageCitations",
    "modelErrorKind",
    "modelMessages",
    "openaiChat",
    "openaiResponses",
    "parseSSE",
    "parseToolArgs",
    "providerMessage",
    "redact",
    "repairJsonObject",
    "resolveModelInfo",
    "responsesBody",
    "retryAfterMs",
    "serverToolSnapshot",
    "serverToolText",
    "testConnection",
    "text",
    "textToolsPrompt",
    "toAnthropicMessages",
    "toCatalogModel",
    "toChatMessages",
    "toGeminiContents",
    "toGeminiSchema",
    "toResponsesInput",
    "toTextToolMessages",
    "trimModelsDev",
    "unansweredCalls",
    "usageCost",
    "userMessage",
    "vendorPreset",
    "withoutDisplay",
  ])
})

test("Ai.compact accepts an additive fourth per-attempt usage observer", async () => {
  const receipts: CompactReceipt[] = []
  const onUsage: NonNullable<Parameters<Ai["compact"]>[3]> = async (receipt) => {
    receipts.push(receipt)
  }
  await onUsage({
    id: "physical-attempt-1",
    late: false,
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.003 },
  })
  await onUsage({ id: "physical-attempt-2", late: true, usage: undefined })
  expect(receipts).toMatchInlineSnapshot(`
    [
      {
        "id": "physical-attempt-1",
        "late": false,
        "usage": {
          "cacheRead": 0,
          "cacheWrite": 0,
          "cost": 0.003,
          "input": 10,
          "output": 1,
        },
      },
      {
        "id": "physical-attempt-2",
        "late": true,
        "usage": undefined,
      },
    ]
  `)
})

test("physical dispatch is a public stream event distinct from optional adapter metadata", () => {
  const event: StreamEvent = { type: "request.attempt", id: "physical-attempt" }
  expect(event).toMatchInlineSnapshot(`
    {
      "id": "physical-attempt",
      "type": "request.attempt",
    }
  `)
})

test("shared usage counts expose reported-output coverage without changing the ai root exports", () => {
  const usage: UsageCounts = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, outputReported: false }
  expect(usage).toMatchInlineSnapshot(`
    {
      "cacheRead": 0,
      "cacheWrite": 0,
      "input": 1,
      "output": 0,
      "outputReported": false,
    }
  `)
})

test("Ai exposes a non-secret live credential source query", async () => {
  const { createAi } = await import("../src/index.ts")
  const env = { KEY: "private-env" }
  const ai = createAi({
    providers: [{ id: "p", dialect: "openai-chat", baseUrl: "https://fake.example", apiKeyEnv: "KEY" }],
    env,
    apiKeys: { p: "private-stored" },
  })
  expect(ai.credentialSource?.("p")).toBe("env")
  expect(Object.keys(ai.providerEndpoint("p")).sort()).toEqual([
    "apiKey",
    "baseUrl",
    "credentialSource",
    "dialect",
  ])
  expect(ai.providerEndpoint("p").credentialSource).toBe("env")
  expect(ai.providerEndpoint("p").apiKey).toBe("private-env")
  env.KEY = ""
  expect(ai.credentialSource?.("p")).toBe("stored")
  expect(ai.providerEndpoint("p").apiKey).toBe("private-stored")
  ai.setStoredKey?.("p", undefined)
  expect(ai.credentialSource?.("p")).toBe("none")
  expect(ai.providerEndpoint("p").apiKey).toBeUndefined()
  ai.registerProvider({ ...ai.providers()[0]!, apiKey: "private-explicit" })
  expect(ai.credentialSource?.("p")).toBe("explicit")
  expect(ai.providerEndpoint("p").apiKey).toBe("private-explicit")
  expect(ai.credentialSource?.("unknown")).toBe("none")
})
