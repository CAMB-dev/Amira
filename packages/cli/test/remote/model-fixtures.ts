import "../server/offline.ts"
import { type Ai, createAi, type Dialect, emptyUsage, type ModelRequest, type StreamEvent } from "@amira/ai"
import { createModelBroker } from "../../src/remote/model-broker.ts"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"

export const KEY = "opaque-local-key=!@#$long-secret"
export const HEADER = "header-secret-without-key-prefix"
export const URL_SECRET = "private-query-value"
export const BASE_URL = `https://url-user:url-pass@approved.invalid/v1?access=${URL_SECRET}`
export const provider = {
  id: "local",
  dialect: "fake",
  baseUrl: BASE_URL,
  apiKey: KEY,
  headers: { "X-Private": HEADER },
  compat: { compaction: "on" as const },
}

export function request(ai: Ai): ModelRequest {
  return {
    model: {
      ...ai.model("local/model/with/slash"),
      provider: "remote",
      contextWindow: 12345,
      maxOutput: 222,
      caps: {
        tools: "none",
        images: false,
        thinking: true,
        promptCache: false,
        parallelToolCalls: false,
        webSearch: false,
      },
      cost: { input: 12, output: 34 },
    },
    systemPrompt: "remote system",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    maxTokens: 77,
    reasoning: { effort: "high" },
    promptCache: false,
  }
}

export const done = (req: ModelRequest, text = "answer"): StreamEvent => ({
  type: "done",
  message: {
    role: "assistant",
    model: { provider: req.model.provider, model: req.model.id },
    content: [{ type: "text", text }],
    usage: emptyUsage(),
    stopReason: "end",
  },
})

export function setup(dialect?: Dialect) {
  const fallback: Dialect = {
    id: "fake",
    async *stream(req) {
      yield done(req)
    },
  }
  const ai = createAi({
    providers: [provider],
    dialects: [dialect ?? fallback],
    retry: { retries: 0 },
    env: {},
  })
  const bindings = new ProviderBindings(ai, [
    {
      provider: "remote",
      dialect: "fake",
      localProvider: "local",
      endpointOrigin: "https://approved.invalid",
    },
  ])
  const broker = createModelBroker({ ai, bindings })
  const req = request(ai)
  const metadata = broker.metadata([req.model])[0]!
  const call = { bindingRevision: metadata.revision, request: req }
  return { ai, bindings, broker, req, call, metadata }
}

export async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
