import { describe, expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { listModels, testConnection } from "../src/probe.ts"
import { events, request } from "./helpers.ts"

const USER_AGENT = "host-app/1.2.3"
const KEY = "test-key"
const dialects = [
  {
    id: "openai-chat",
    keyHeader: "authorization",
    keyValue: `Bearer ${KEY}`,
    reply: { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] },
    list: { data: [{ id: "m" }] },
  },
  {
    id: "openai-responses",
    keyHeader: "authorization",
    keyValue: `Bearer ${KEY}`,
    reply: {
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
    },
    list: { data: [{ id: "m" }] },
  },
  {
    id: "anthropic-messages",
    keyHeader: "x-api-key",
    keyValue: KEY,
    reply: { type: "message", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" },
    list: { data: [{ id: "m" }], has_more: false },
  },
  {
    id: "google-gemini",
    keyHeader: "x-goog-api-key",
    keyValue: KEY,
    reply: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] },
    list: { models: [{ name: "models/m", supportedGenerationMethods: ["generateContent"] }] },
  },
]

interface HeaderCase {
  name: string
  userAgent?: string
  headers?: Record<string, string>
  expected?: string
}

const cases: HeaderCase[] = [
  { name: "no user agent" },
  { name: "supplied user agent", userAgent: USER_AGENT, expected: USER_AGENT },
  { name: "empty user agent is preserved", userAgent: "", expected: "" },
  ...["user-agent", "User-Agent", "uSeR-aGeNt"].map((name) => ({
    name: `${name} overrides the supplied user agent`,
    userAgent: USER_AGENT,
    headers: { [name]: "provider/9" },
    expected: "provider/9",
  })),
  { name: "provider-only user agent", headers: { "User-Agent": "provider/9" }, expected: "provider/9" },
  {
    name: "last case-insensitive provider header wins",
    userAgent: USER_AGENT,
    headers: { "user-agent": "first/1", "USER-AGENT": "last/2" },
    expected: "last/2",
  },
]

/** No network: records the unnormalized headers passed to the injected fetch. */
function capture(respond: (url: string) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> })
    return respond(url)
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

function expectHeader(headers: Record<string, string>, name: string, value: string | undefined) {
  expect(headers).not.toBeInstanceOf(Headers)
  const keys = Object.keys(headers).filter((key) => key.toLowerCase() === name)
  expect(keys).toHaveLength(value === undefined ? 0 : 1)
  if (value !== undefined) expect(headers[keys[0]!]).toBe(value)
  // A real Fetch Headers conversion must not concatenate duplicate spellings.
  expect(new Headers(headers).get(name)).toBe(value ?? null)
  if (name === "user-agent" && value !== undefined) expect(keys).toEqual(["user-agent"])
}

for (const dialect of dialects) {
  describe(`${dialect.id} user agent`, () => {
    for (const scenario of cases) {
      test(`model requests: ${scenario.name}`, async () => {
        const seen = capture(() => Response.json(dialect.reply))
        const headers = {
          ...scenario.headers,
          [dialect.keyHeader.toUpperCase()]: "override-key",
          "Content-Type": "application/custom+json",
        }
        const ai = createAi({
          fetch: seen.fetch,
          userAgent: scenario.userAgent,
          retry: { retries: 0 },
          providers: [{ id: "test", dialect: dialect.id, baseUrl: "https://test/v1", apiKey: KEY, headers }],
        })
        expect((await events(ai.stream(request(ai)))).at(-1)?.type).toBe("done")
        expect(seen.calls).toHaveLength(1)
        const sent = seen.calls[0]!.headers
        expectHeader(sent, "user-agent", scenario.expected)
        expectHeader(sent, dialect.keyHeader, "override-key")
        expectHeader(sent, "content-type", "application/custom+json")
        expect(headers).toEqual({
          ...scenario.headers,
          [dialect.keyHeader.toUpperCase()]: "override-key",
          "Content-Type": "application/custom+json",
        })
      })

      test(`connection tests: ${scenario.name}`, async () => {
        const seen = capture(() => Response.json(dialect.reply))
        const result = await testConnection(
          { dialect: dialect.id, baseUrl: "https://test/v1", apiKey: KEY, headers: scenario.headers },
          "m",
          { fetch: seen.fetch, userAgent: scenario.userAgent },
        )
        expect(result.ok).toBe(true)
        expect(seen.calls).toHaveLength(1)
        expectHeader(seen.calls[0]!.headers, "user-agent", scenario.expected)
        expectHeader(seen.calls[0]!.headers, dialect.keyHeader, dialect.keyValue)
      })

      test(`model lists: ${scenario.name}`, async () => {
        const seen = capture(() => Response.json(dialect.list))
        const models = await listModels(
          {
            dialect: dialect.id,
            baseUrl: "https://test/v1",
            apiKey: KEY,
            headers: { ...scenario.headers, Accept: "application/custom+json" },
          },
          { fetch: seen.fetch, userAgent: scenario.userAgent },
        )
        expect(models).toEqual([{ id: "m" }])
        expect(seen.calls).toHaveLength(1)
        expectHeader(seen.calls[0]!.headers, "user-agent", scenario.expected)
        expectHeader(seen.calls[0]!.headers, "accept", "application/custom+json")
        expectHeader(seen.calls[0]!.headers, dialect.keyHeader, dialect.keyValue)
      })
    }
  })
}

const compactions = [
  { dialect: "openai-responses", method: "trigger" },
  { dialect: "openai-responses", method: "endpoint" },
  { dialect: "anthropic-messages", method: "summarize" },
]

for (const compaction of compactions) {
  describe(`${compaction.dialect} ${compaction.method} compaction user agent`, () => {
    for (const scenario of cases) {
      test(scenario.name, async () => {
        const seen = capture((url) => {
          if (compaction.method === "endpoint" && !url.endsWith("/compact")) {
            return new Response("not supported", { status: 404 })
          }
          return compaction.dialect === "anthropic-messages"
            ? Response.json({
                type: "message",
                content: [{ type: "compaction", content: "Summary", signature: "signed" }],
                stop_reason: "compaction",
              })
            : Response.json({
                status: "completed",
                output: [{ type: "compaction", id: "cmp_1", encrypted_content: "encrypted" }],
              })
        })
        const ai = createAi({
          fetch: seen.fetch,
          userAgent: scenario.userAgent,
          retry: { retries: 0 },
          providers: [
            {
              id: "test",
              dialect: compaction.dialect,
              baseUrl: "https://test/v1",
              apiKey: KEY,
              headers: scenario.headers,
              compat: { compaction: "on" },
            },
          ],
        })
        const result = await ai.compact(request(ai))
        expect(result.ok && result.method).toBe(compaction.method)
        expect(seen.calls).toHaveLength(compaction.method === "endpoint" ? 2 : 1)
        for (const call of seen.calls) {
          expectHeader(call.headers, "user-agent", scenario.expected)
          expectHeader(call.headers, "content-type", "application/json")
          if (compaction.dialect === "anthropic-messages") {
            expectHeader(call.headers, "anthropic-beta", "compact-2026-09-04")
          }
        }
      })
    }
  })
}
