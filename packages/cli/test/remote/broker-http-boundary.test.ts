import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi, type Dialect, type ModelRequest } from "@amira/ai"
import { createModelBroker } from "../../src/remote/model-broker.ts"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"
import { collectEvents } from "./model-proxy-fixture.ts"

const origin = "https://approved.invalid"
const key = "SENTINEL_BROKER_HTTP_KEY"

for (const operation of ["stream", "compact"] as const) {
  for (const scenario of ["unapproved", "retry", "redirect"] as const) {
    test(`broker ${operation} uses the injected Ai and enforces HTTP approval for ${scenario}`, async () => {
      const sent: { url: string; redirect: RequestInit["redirect"]; key: string | null }[] = []
      let wrappedCalls = 0
      let dialectCalls = 0
      const target = () =>
        scenario === "unapproved" || (scenario === "retry" && sent.length)
          ? "https://unapproved.invalid/collect"
          : `${origin}/request`
      const dialect: Dialect = {
        id: "boundary",
        async *stream(req, ctx) {
          dialectCalls++
          const response = await ctx.fetch(target(), { headers: { authorization: ctx.endpoint.apiKey! } })
          yield response.ok
            ? {
                type: "done",
                message: { role: "assistant", content: [], model: { provider: "p", model: req.model.id } },
              }
            : {
                type: "error",
                error: { message: "transient", status: 503 },
                retryable: true,
                message: { role: "assistant", content: [], model: { provider: "p", model: req.model.id } },
              }
        },
        compaction: {
          methods: ["native"],
          layouts: ["tail"],
          midTurn: true,
          official: () => true,
          async compact(_method, _req, ctx) {
            dialectCalls++
            const response = await ctx.fetch(target(), { headers: { authorization: ctx.endpoint.apiKey! } })
            return response.ok
              ? { ok: true, value: "checkpoint" }
              : { ok: false, error: { message: "transient" }, retryable: true, unsupported: false }
          },
        },
      }
      const actual = createAi({
        providers: [{ id: "p", dialect: dialect.id, baseUrl: `${origin}/v1`, apiKey: key }],
        dialects: [dialect],
        env: {},
        retry: { retries: 1, baseDelayMs: 0 },
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            sent.push({
              url: String(input),
              redirect: init?.redirect,
              key: new Headers(init?.headers).get("authorization"),
            })
            return new Response("", {
              status: scenario === "redirect" ? 307 : 503,
              ...(scenario === "redirect" ? { headers: { location: "https://unapproved.invalid" } } : {}),
            })
          },
          { preconnect() {} },
        ),
      })
      const ai = {
        ...actual,
        stream: (...args: Parameters<typeof actual.stream>) => {
          wrappedCalls++
          return actual.stream(...args)
        },
        compact: (...args: Parameters<typeof actual.compact>) => {
          wrappedCalls++
          return actual.compact(...args)
        },
      }
      const bindings = new ProviderBindings(ai)
      const bindingRevision = bindings.approve({
        provider: "p",
        localProvider: "p",
        dialect: dialect.id,
        endpointOrigin: origin,
      })
      const broker = createModelBroker({ ai, bindings })
      const request: ModelRequest = {
        model: ai.model("p/remote-model-override"),
        systemPrompt: "",
        messages: [],
        tools: [],
      }
      const call = { request, bindingRevision }
      if (operation === "stream") {
        const events = await collectEvents(broker.stream(call))
        expect(events.at(-1)?.type).toBe("error")
      } else expect((await broker.compact(call)).ok).toBe(false)
      expect(wrappedCalls).toBe(1)
      expect(dialectCalls).toBeGreaterThan(0)
      expect(sent).toEqual(
        scenario === "unapproved" ? [] : [{ url: `${origin}/request`, redirect: "error", key }],
      )
    })
  }
}
