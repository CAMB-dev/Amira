import { expect, test } from "bun:test"
import type { ProviderAdmin, SessionControl, UiContext, UiControl, UiState } from "@amira/api"
import { ProviderConnectionTests } from "../src/provider-tests.ts"
import {
  ADD_PROVIDER_KEY,
  type ProviderHubAction,
  type ProviderHubData,
  providerView,
} from "../src/provider-view.ts"

function makeHub(
  providers: ReturnType<SessionControl["providers"]> = [
    { id: "deepseek", dialect: "openai-chat", baseUrl: "https://api.deepseek.com", hasKey: true },
    {
      id: "anthropic",
      dialect: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      hasKey: false,
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
  ],
  current = { provider: "deepseek", model: "deepseek-chat" },
) {
  const actions: ProviderHubAction[] = []
  let closed = 0
  let redraws = 0
  let lastPatch: Partial<UiState> | undefined
  const admin: ProviderAdmin = {
    dialects: () => ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"],
    cachedVendors: () => [
      {
        id: "anthropic",
        name: "Anthropic",
        dialect: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        env: ["ANTHROPIC_API_KEY"],
        models: [],
      },
      {
        id: "kimi",
        name: "Moonshot Kimi",
        dialect: "openai-chat",
        baseUrl: "https://api.moonshot.ai/v1",
        env: ["MOONSHOT_API_KEY"],
        models: [],
      },
    ],
    exists: (id) => providers.some((p) => p.id === id),
    draft: (id) =>
      id === "deepseek"
        ? {
            id,
            dialect: "openai-chat",
            baseUrl: "https://api.deepseek.com",
            keySource: "auth",
            models: ["deepseek-chat", "deepseek-reasoner"],
          }
        : id === "anthropic"
          ? {
              id,
              dialect: "anthropic-messages",
              baseUrl: "https://api.anthropic.com",
              keySource: "env",
              apiKeyEnv: "ANTHROPIC_API_KEY",
              models: ["claude-sonnet-4-5"],
            }
          : undefined,
    storedKeyHint: (id) => (id === "deepseek" ? "…wxyz" : undefined),
    envIsSet: () => false,
    listModels: async () => [],
    describeModels: (_d, ids) =>
      ids.map((id) => ({
        id,
        contextWindow: 128_000,
        cost: { input: 0.27, output: 1.1 },
        inCatalog: true,
      })),
    test: async () => ({ ok: true, latencyMs: 12, message: "OK" }),
    save: async () => "Saved",
    remove: async () => "Removed",
    setKey: async () => "Stored",
  }
  const session = {
    providers: () => providers,
    models: () => ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
    info: () => ({
      id: "s1",
      cwd: "/work",
      model: current,
      contextWindow: 128_000,
      busy: false,
      shell: "auto",
    }),
  } as unknown as SessionControl
  const tests = new ProviderConnectionTests()
  const data: ProviderHubData = {
    sessionId: "s1",
    session,
    admin,
    tests,
    onAction: (action) => actions.push(action),
  }
  const state: UiState = {
    selected: {},
    expanded: {},
    activeTabs: {},
    scroll: {},
    inputValues: {},
  }
  const ctx: UiContext = {
    width: 120,
    height: 30,
    now: Date.now(),
    toolDetail: "summary",
    state,
  }
  const control: UiControl = {
    close: () => {
      closed++
    },
    pushPage: () => {},
    popPage: () => {},
    requestRender: () => {
      redraws++
    },
    print: () => {},
    prompt: async () => undefined,
    confirm: async () => false,
    setState: (patch) => {
      lastPatch = patch
    },
    focus: () => {},
  }
  return {
    view: providerView(),
    data,
    ctx,
    control,
    actions,
    closed: () => closed,
    redraws: () => redraws,
    lastPatch: () => lastPatch,
  }
}

test("providerView renders unified split-pane hub with + Add provider in list and configured details", () => {
  const hub = makeHub()
  const tree = hub.view.ui!(hub.data, hub.ctx)
  const json = JSON.stringify(tree)
  expect(hub.view.title(hub.data, hub.ctx)).toBe("Providers (2)")
  expect(json).toContain("Add provider")
  expect(json).toContain("Use model")
  expect(json).toContain("Edit")
  expect(json).toContain("Set key")
  expect(json).toContain("Test")
  expect(json).toContain("Remove")
  expect(json).toContain("deepseek-chat")
  expect(json).toContain("auth.json (…wxyz)")
})

test("providerView opens in-place Add Provider Studio with popular vendors, protocols and catalog search", () => {
  const hub = makeHub([], { provider: "", model: "" })
  const tree = hub.view.ui!(hub.data, hub.ctx)
  const json = JSON.stringify(tree)
  expect(hub.view.title(hub.data, hub.ctx)).toBe("Providers (0)")
  expect(json).toContain("Popular vendors")
  expect(json).toContain("Anthropic")
  expect(json).toContain("DeepSeek")
  expect(json).toContain("OpenAI-Compat")
  expect(json).toContain("Custom form")
  expect(json).toContain("Moonshot Kimi")

  // Filtering narrows the catalog list in-place.
  hub.ctx.state.inputValues["providers.vendorFilter"] = "kimi"
  const filtered = JSON.stringify(hub.view.ui!(hub.data, hub.ctx))
  expect(filtered).toContain("Moonshot Kimi")
  expect(filtered).not.toContain("(anthropic)")
})

test("providerView switches to Add Studio in-place without closing, and dispatches vendor/protocol/provider actions", () => {
  const hub = makeHub()
  // Clicking + Add provider switches right pane in-place without closing the view.
  hub.view.onEvent!({ type: "activate", id: "providers.add", key: "providers.add" }, hub.data, hub.control)
  expect(hub.data.highlight).toBe(ADD_PROVIDER_KEY)
  expect(hub.lastPatch()?.selected?.["providers.list"]).toBe(ADD_PROVIDER_KEY)
  expect(hub.closed()).toBe(0)

  // Clicking a popular vendor button dispatches prefilled add with that vendor id.
  hub.view.onEvent!({ type: "activate", id: "vendor:deepseek", key: "deepseek" }, hub.data, hub.control)
  expect(hub.actions.at(-1)).toEqual({ kind: "add", choice: "deepseek" })

  // Clicking a protocol button dispatches add with that dialect.
  hub.view.onEvent!(
    { type: "activate", id: "protocol:openai-chat", key: "openai-chat" },
    hub.data,
    hub.control,
  )
  expect(hub.actions.at(-1)).toEqual({ kind: "add", choice: "openai-chat" })

  // Selecting anthropic and clicking Edit/Test dispatches for anthropic.
  hub.view.onEvent!({ type: "select", id: "providers.list", key: "anthropic" }, hub.data, hub.control)
  hub.view.onEvent!({ type: "activate", id: "providers.edit", key: "providers.edit" }, hub.data, hub.control)
  expect(hub.actions.at(-1)).toEqual({ kind: "edit", id: "anthropic" })
  hub.view.onEvent!({ type: "key", key: "k" }, hub.data, hub.control)
  expect(hub.actions.at(-1)).toEqual({ kind: "key", id: "anthropic" })
  expect(hub.closed()).toBe(4)
})
