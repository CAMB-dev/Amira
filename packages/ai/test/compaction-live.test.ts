import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { Message, ModelRequest, StreamEvent } from "../src/types.ts"

// Server-side compaction against a real endpoint, for manual runs only. Skipped unless
// AMIRA_LIVE_COMPACTION is set. Settings (environment):
// - AMIRA_LIVE_COMPACTION_DIALECT: openai-responses (default) or anthropic-messages
// - AMIRA_LIVE_COMPACTION_BASE_URL: default https://api.openai.com/v1 (or https://api.anthropic.com)
// - AMIRA_LIVE_COMPACTION_MODEL: the model id, e.g. gpt-5.4-mini or claude-sonnet-5-5
// - AMIRA_LIVE_COMPACTION_KEY_ENV: the variable holding the key (default OPENAI_API_KEY or
//   ANTHROPIC_API_KEY); leave the variable it names unset for a local proxy without keys
// - AMIRA_LIVE_COMPACTION_OTHER_MODEL: optional, a second model to see whether the checkpoint
//   is rejected or ignored there (answers the open question of cross-model replay)
const env = process.env
const live = Boolean(env.AMIRA_LIVE_COMPACTION)
const dialect = env.AMIRA_LIVE_COMPACTION_DIALECT ?? "openai-responses"
const anthropic = dialect === "anthropic-messages"
const baseUrl =
  env.AMIRA_LIVE_COMPACTION_BASE_URL ??
  (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1")
const model = env.AMIRA_LIVE_COMPACTION_MODEL ?? (anthropic ? "claude-sonnet-5-5" : "gpt-5.4-mini")
const keyEnv = env.AMIRA_LIVE_COMPACTION_KEY_ENV ?? (anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")
const other = env.AMIRA_LIVE_COMPACTION_OTHER_MODEL
const TIMEOUT = 300_000

const ai = createAi({
  providers: [
    {
      id: "live",
      dialect,
      baseUrl,
      ...(env[keyEnv] ? { apiKeyEnv: keyEnv } : {}),
      // Every host, so a local proxy is tried too.
      compat: { compaction: "on" },
      models: [{ id: model, maxOutput: 4_096 }],
    },
  ],
})

const history: Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Remember this: the secret word is PELICAN-42. Reply with OK only." }],
  },
  { role: "assistant", model: { provider: "live", model }, content: [{ type: "text", text: "OK" }] },
  {
    role: "user",
    content: [{ type: "text", text: "Also: the build uses bun, not npm. Reply with OK only." }],
  },
  { role: "assistant", model: { provider: "live", model }, content: [{ type: "text", text: "OK" }] },
]

async function ask(modelId: string, messages: Message[]): Promise<string> {
  const req: ModelRequest = {
    model: ai.model(`live/${modelId}`),
    systemPrompt: "You are terse.",
    messages,
    tools: [],
  }
  let text = ""
  for await (const ev of ai.stream(req) as AsyncIterable<StreamEvent>) {
    if (ev.type === "error") throw new Error(ev.error.message)
    if (ev.type === "done")
      text = ev.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
  }
  return text
}

test.skipIf(!live)(
  "a live server compacts, and its checkpoint carries the conversation",
  async () => {
    const r = await ai.compact({
      model: ai.model(`live/${model}`),
      systemPrompt: "You are terse.",
      messages: history,
      tools: [],
    })
    console.log(
      "compaction:",
      JSON.stringify({ ...r, checkpoint: r.ok ? `${r.checkpoint.value.length} chars` : undefined }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const after: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: `Summary:\n\n${r.summary ?? ""}`, signature: r.checkpoint }],
      },
      {
        role: "assistant",
        model: { provider: "amira", model: "compaction" },
        content: [{ type: "text", text: "OK", signature: r.checkpoint }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "What is the secret word? Answer with the word only." }],
      },
    ]
    const answer = await ask(model, after)
    console.log("same model answers:", answer)
    expect(answer).toContain("PELICAN")
    if (other) {
      // Amira never sends the checkpoint to another model; this checks what a server does when
      // one is sent anyway, by replaying the raw item as the same model would.
      try {
        const forged = after.map((m) =>
          m.role === "toolResult"
            ? m
            : ({
                ...m,
                content: m.content.map((b) =>
                  b.type === "text" && b.signature
                    ? { ...b, signature: { ...b.signature, model: other } }
                    : b,
                ),
              } as Message),
        )
        console.log("other model answers:", await ask(other, forged))
      } catch (e) {
        console.log("other model rejects the checkpoint:", (e as Error).message)
      }
    }
  },
  TIMEOUT,
)
