import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type CompactReceipt, createAi } from "@amira/ai"
import { collectEvents } from "./model-proxy-fixture.ts"
import { providerHeaderFixture } from "./provider-header-fixture.ts"

const token = "SENTINEL_TRIMMED_HEADER_SECRET"
const raw = ` ${token} `

function sse(chunks: unknown[]) {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

for (const operation of ["stream", "compact"] as const) {
  test(`built-in OpenAI ${operation} cannot echo an HTTP-trimmed header into real model frames or receipts`, async () => {
    const echoes: string[] = []
    const ai = createAi({
      providers: [
        {
          id: "p",
          dialect: operation === "stream" ? "openai-chat" : "openai-responses",
          baseUrl: "https://provider.invalid/v1",
          apiKey: "SENTINEL_OTHER_API_KEY",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exercise the reported padded substitution
          headers: { "X-Private": "${TOKEN}" },
          compat: { compaction: "on" },
        },
      ],
      env: { TOKEN: raw },
      retry: { retries: 0 },
      fetch: Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const effective = new Headers(init?.headers).get("X-Private")!
          echoes.push(effective)
          if (operation === "stream")
            return sse([
              { choices: [{ delta: { content: effective }, finish_reason: "stop" }] },
              { choices: [], service_tier: effective, usage: { prompt_tokens: 2, completion_tokens: 1 } },
            ])
          return sse([
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "compaction", id: "cmp_1", encrypted_content: effective },
            },
            {
              type: "response.completed",
              response: { service_tier: effective, usage: { input_tokens: 2, output_tokens: 1 } },
            },
          ])
        },
        { preconnect() {} },
      ),
    })
    const fixture = providerHeaderFixture(ai)
    const receipts: CompactReceipt[] = []
    try {
      await fixture.connect()
      const result =
        operation === "stream"
          ? await collectEvents(fixture.proxy.stream(fixture.request))
          : await fixture.proxy.compact(fixture.request, undefined, undefined, (receipt) => {
              receipts.push(receipt)
            })
      expect(echoes).toEqual([token])
      if (Array.isArray(result)) {
        expect(result.at(-1)?.type).toBe("done")
        expect(result.some((event) => event.type === "text.delta")).toBe(true)
      } else {
        expect(result.ok).toBe(true)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]?.usage?.serviceTier).toBe("[redacted]")
        expect(fixture.observed.join("")).toContain('"receipt"')
      }
      expect(JSON.stringify({ result, receipts })).not.toContain(token)
      expect(fixture.observed.join("")).not.toContain(token)
    } finally {
      fixture.close()
    }
  })
}
