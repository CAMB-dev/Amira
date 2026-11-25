import { expect, test } from "bun:test"
import type { ProviderAdmin, SessionControl } from "@amira/api"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { setup, waitFor } from "./app-harness.ts"

test("fullscreen /provider hub clicks select providers, switch to Add Studio, open forms and return cleanly", async () => {
  const savedIds: string[] = []
  const providers = [
    { id: "deepseek", dialect: "openai-chat", baseUrl: "https://api.deepseek.com", hasKey: true },
    {
      id: "anthropic",
      dialect: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      hasKey: false,
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
  ]
  const admin: ProviderAdmin = {
    dialects: () => ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"],
    cachedVendors: () => [
      {
        id: "deepseek",
        name: "DeepSeek",
        dialect: "openai-chat",
        baseUrl: "https://api.deepseek.com/v1",
        env: ["DEEPSEEK_API_KEY"],
        models: ["deepseek-chat"],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        dialect: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        env: ["ANTHROPIC_API_KEY"],
        models: ["claude-sonnet-4-5"],
      },
    ],
    vendors: async () => admin.cachedVendors!(),
    exists: (id) => providers.some((p) => p.id === id),
    draft: (id) =>
      id === "deepseek"
        ? {
            id,
            dialect: "openai-chat",
            baseUrl: "https://api.deepseek.com",
            keySource: "auth",
            models: ["deepseek-chat"],
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
    describeModels: (_d, ids) => ids.map((id) => ({ id, inCatalog: false })),
    test: async () => ({ ok: true, latencyMs: 10, message: "OK" }),
    save: async (draft) => {
      savedIds.push(draft.id)
      return `Saved ${draft.id}`
    },
    remove: async () => "Removed",
    setKey: async () => "Stored",
  }
  const control = {
    providers: () => providers,
    models: () => ["deepseek/deepseek-chat"],
    setModel: () => {},
    setThinking: () => {},
    info: () => ({
      id: "s1",
      cwd: "/work",
      model: { provider: "deepseek", model: "deepseek-chat" },
      contextWindow: 128_000,
      busy: false,
      shell: "auto",
    }),
    providerAdmin: admin,
  } as unknown as SessionControl

  const app = await setup([], {
    cols: 120,
    rows: 32,
    extensions: [commandsExtension],
    control,
  })
  const clickText = (text: string, offset = 2) => {
    const y = app.screen.lines.findIndex((line) => line.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    const x = app.screen.lines[y]!.indexOf(text) + offset
    app.terminal.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
  }
  try {
    app.terminal.send("/provider\r")
    await waitFor(() => app.live().includes("deepseek-chat"), "provider hub opened on deepseek", 1000)

    // 1. Clicking another provider in the left list selects it IN-PLACE (does NOT exit!).
    clickText("○ anthropic")
    await waitFor(() => app.live().includes("claude-sonnet-4-5"), "anthropic selected in-place", 1000)
    expect(app.live()).toContain("[Edit]")

    // 2. Clicking [+ Add provider] switches right pane IN-PLACE to Add Provider Studio!
    clickText("[+ Add provider]")
    await waitFor(() => app.live().includes("Popular vendors"), "add studio opened in-place", 1000)
    expect(app.live()).toContain("[OpenAI-Compat]")

    // 3. Clicking [OpenAI-Compat] opens the real Add Provider Form Card (does NOT exit to chat!).
    clickText("[OpenAI-Compat]")
    await waitFor(() => app.live().includes("Base URL *"), "add form card opened from hub button", 1000)
    expect(app.live()).toContain("[ auth.json ] [ Environment variable ] [ No key ]")

    // 4. Cancelling the form returns seamlessly to the Unified Provider Hub!
    clickText("[ Cancel ]")
    await waitFor(() => app.live().includes("Popular vendors"), "returned to provider hub after cancel", 1000)

    // 5. Selecting deepseek and clicking [Edit] opens Edit Provider Form Card!
    clickText("● deepseek")
    await waitFor(() => app.live().includes("[Edit]"), "deepseek re-selected", 1000)
    expect(app.live()).toContain("auth.json (…wxyz)")
    clickText("[Edit]")
    await waitFor(() => app.live().includes("Edit provider · deepseek"), "edit form opened from hub", 1000)
    clickText("[ Cancel ]")
    await waitFor(() => app.live().includes("auth.json (…wxyz)"), "returned to hub after edit cancel", 1000)

    // 6. Clicking [Close] exits the hub cleanly back to chat.
    clickText("[Close]")
    await waitFor(
      () => !app.live().includes("Popular vendors") && !app.live().includes("[Use model]"),
      "hub closed",
      1000,
    )
    expect(savedIds).toEqual([])
  } finally {
    app.terminal.send("\x03")
    await Bun.sleep(20)
    app.terminal.send("\x03\x03")
    await app.exited
  }
})
