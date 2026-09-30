import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type {
  AssistantMessage,
  Message,
  ServerToolBlock,
  StreamEvent,
  TextBlock,
  ToolSpec,
} from "../src/types.ts"

// Hosted web search against a real Responses endpoint, only when AMIRA_LIVE_WEB_SEARCH holds
// its API key. AMIRA_LIVE_WEB_SEARCH_URL (default https://api.openai.com/v1) and
// AMIRA_LIVE_WEB_SEARCH_MODEL (default gpt-5) pick the endpoint and the model.
const KEY_ENV = "AMIRA_LIVE_WEB_SEARCH"
const noKey = !process.env[KEY_ENV]
const TIMEOUT = 300_000
const MODEL = process.env.AMIRA_LIVE_WEB_SEARCH_MODEL || "gpt-5"

const ai = createAi({
  retry: { retries: 1 },
  providers: [
    {
      id: "live",
      dialect: "openai-responses",
      baseUrl: process.env.AMIRA_LIVE_WEB_SEARCH_URL || "https://api.openai.com/v1",
      apiKeyEnv: KEY_ENV,
      catalogId: false,
      compat: { webSearch: true },
    },
  ],
})

const readFile: ToolSpec = {
  name: "read_file",
  description: "Reads a file of the user's workspace.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}

async function turn(messages: Message[]) {
  const evs: StreamEvent[] = []
  for await (const ev of ai.stream({
    model: ai.model(`live/${MODEL}`),
    systemPrompt: "You are a helpful assistant.",
    messages,
    tools: [readFile],
  })) {
    evs.push(ev)
  }
  const last = evs.at(-1)
  if (last?.type !== "done") throw new Error(`the request failed: ${JSON.stringify(last)}`)
  return { evs, message: last.message as AssistantMessage }
}

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

test.skipIf(noKey)(
  "searches on the server, answers after it with citations, and a follow-up replays the search",
  async () => {
    const first = user("请联网搜索 Node.js 当前最新稳定版本，引用 Node.js 官方来源。")
    const { evs, message } = await turn([first])
    const searches = message.content.filter((b): b is ServerToolBlock => b.type === "serverTool")
    expect(searches.length).toBeGreaterThan(0)
    expect(searches.every((s) => s.status === "done" && s.signature?.host)).toBe(true)
    // The answer came after the searches.
    const firstSearch = evs.findIndex((e) => e.type === "serverTool")
    const firstText = evs.findIndex((e) => e.type === "text.delta")
    expect(firstSearch).toBeGreaterThanOrEqual(0)
    expect(firstText).toBeGreaterThan(firstSearch)
    const text = message.content.filter((b): b is TextBlock => b.type === "text")
    expect(text.flatMap((b) => b.citations ?? []).length).toBeGreaterThan(0)
    expect(message.content.some((b) => b.type === "toolCall")).toBe(false)

    // A local function still works in the same conversation, next to the replayed search.
    const ask = user("Now call read_file with path notes.txt. Do not search again.")
    const second = await turn([first, message, ask])
    const call = second.message.content.find((b) => b.type === "toolCall")
    expect(call?.type).toBe("toolCall")
    if (call?.type !== "toolCall") return
    const result: Message = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "The secret word is marmalade-42." }],
      isError: false,
    }
    const third = await turn([first, message, ask, second.message, result])
    const answer = third.message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(answer).toContain("marmalade-42")
  },
  TIMEOUT,
)
