import { expect, test } from "bun:test"

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
