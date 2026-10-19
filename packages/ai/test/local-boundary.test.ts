import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { Dialect } from "../src/dialect.ts"
import { withAiRequestBoundary } from "../src/local.ts"
import type { ModelRequest } from "../src/types.ts"
import { events } from "./helpers.ts"

const origin = "https://approved.invalid"
const secret = "SENTINEL_LOCAL_BOUNDARY_KEY"

function fixture(target: () => string, retries = 0) {
  const seen: { url: string; redirect: RequestInit["redirect"]; key: string | null }[] = []
  const dialect: Dialect = {
    id: "boundary",
    async *stream(req, ctx) {
      const response = await ctx.fetch(target(), { headers: { authorization: secret } })
      if (!response.ok) {
        yield {
          type: "error",
          error: { message: "retry me", status: 503 },
          retryable: true,
          message: { role: "assistant", content: [], model: { provider: "p", model: req.model.id } },
        }
      } else {
        yield {
          type: "done",
          message: { role: "assistant", content: [], model: { provider: "p", model: req.model.id } },
        }
      }
    },
    compaction: {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact(_method, _request, ctx) {
        const response = await ctx.fetch(target(), { headers: { authorization: secret } })
        return response.ok
          ? { ok: true, value: "checkpoint" }
          : { ok: false, error: { message: "retry me" }, retryable: true, unsupported: false }
      },
    },
  }
  const ai = createAi({
    providers: [{ id: "p", dialect: dialect.id, baseUrl: `${origin}/v1`, apiKey: secret }],
    dialects: [dialect],
    env: {},
    retry: { retries, baseDelayMs: 0 },
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push({
          url: String(input),
          redirect: init?.redirect,
          key: new Headers(init?.headers).get("authorization"),
        })
        return new Response("", { status: retries && seen.length === 1 ? 503 : 200 })
      },
      { preconnect() {} },
    ),
  })
  const request: ModelRequest = { model: ai.model("p/m"), systemPrompt: "", messages: [], tools: [] }
  return { ai, request, seen }
}

for (const operation of ["stream", "compact"] as const) {
  test(`${operation}: the actual fetch boundary rejects a dialect-selected unapproved origin`, async () => {
    const { ai, request, seen } = fixture(() => "https://unapproved.invalid/collect")
    const scoped = withAiRequestBoundary({ ...ai }, { origin })
    if (operation === "stream") await events(scoped.stream(request)).catch(() => {})
    else await scoped.compact(request)
    expect(seen).toEqual([])
  })

  test(`${operation}: every retry is checked and redirects cannot carry credentials onward`, async () => {
    const { ai, request, seen } = fixture(
      () => (seen.length ? "https://unapproved.invalid/retry" : `${origin}/request`),
      1,
    )
    const scoped = withAiRequestBoundary({ ...ai }, { origin })
    if (operation === "stream") await events(scoped.stream(request)).catch(() => {})
    else await scoped.compact(request)
    expect(seen).toEqual([{ url: `${origin}/request`, redirect: "error", key: secret }])
  })
}

for (const id of ["../../../collect", "%2e%2e/collect", "m?route=collect", "m#collect", "m\\collect"]) {
  test(`Gemini model resource cannot change the request path/query/fragment: ${id}`, async () => {
    const seen: string[] = []
    const ai = createAi({
      providers: [{ id: "p", dialect: "google-gemini", baseUrl: `${origin}/v1`, apiKey: secret }],
      env: {},
      retry: { retries: 0 },
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          seen.push(String(input))
          return Response.json({ candidates: [] })
        },
        { preconnect() {} },
      ),
    })
    const scoped = withAiRequestBoundary(ai, { origin })
    await events(
      scoped.stream({ model: ai.model(`p/${id}`), systemPrompt: "", messages: [], tools: [] }),
    ).catch(() => {})
    expect(seen).toEqual([])
  })
}
