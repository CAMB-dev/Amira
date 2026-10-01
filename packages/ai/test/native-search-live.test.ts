import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import { userMessage } from "../src/types.ts"

// The gate holds the API key; optional *_MODEL selects the model. Never enabled by ordinary keys.
for (const [gate, dialect, baseUrl, defaultModel] of [
  ["AMIRA_LIVE_ANTHROPIC_SEARCH", "anthropic-messages", "https://api.anthropic.com", "claude-sonnet-4-6"],
  [
    "AMIRA_LIVE_GEMINI_SEARCH",
    "google-gemini",
    "https://generativelanguage.googleapis.com/v1beta",
    "gemini-3-flash-preview",
  ],
] as const) {
  test.skipIf(!process.env[gate])(
    `${dialect}: live search, citations and follow-up with function tools`,
    async () => {
      const ai = createAi({
        retry: { retries: 0 },
        providers: [{ id: "live", dialect, baseUrl, apiKeyEnv: gate }],
      })
      const model = ai.model(`live/${process.env[`${gate}_MODEL`] || defaultModel}`)
      const tools = [
        {
          name: "read_file",
          description: "Read a workspace file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ]
      const first = userMessage(
        "Search the web for the current Bun stable release and cite official sources. Do not call read_file.",
      )
      const message = await collect(ai.stream({ model, systemPrompt: "", messages: [first], tools }))
      expect(message.stopReason).toBe("end")
      expect(message.content.some((b) => b.type === "serverTool" && b.status === "done")).toBe(true)
      expect(message.content.some((b) => b.type === "text" && b.citations?.length)).toBe(true)
      const next = await collect(
        ai.stream({
          model,
          systemPrompt: "",
          messages: [
            first,
            message,
            userMessage("Summarize that release in one sentence without searching again."),
          ],
          tools,
        }),
      )
      expect(next.stopReason).toBe("end")
      expect(next.content.some((b) => b.type === "text" && b.text)).toBe(true)
    },
    300_000,
  )
}
