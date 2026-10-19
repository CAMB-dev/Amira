import "../server/offline.ts"
import { expect, test } from "bun:test"
import { emptyUsage } from "@amira/ai"
import { collectEvents, proxyFixture } from "./model-proxy-fixture.ts"

for (const source of ["literal", "environment", "stored"] as const) {
  test(`${source} credentials, interpolated headers and URL secrets are absent from EVERY remotely observable frame`, async () => {
    const key = `SENTINEL_${source}_provider_key`
    const header = `SENTINEL_${source}_interpolated_header`
    const password = `SENTINEL_${source}_url_password`
    const query = `SENTINEL_${source}_url_query`
    const baseUrl = `https://user:${password}@provider.invalid/v1?secret=${query}`
    const sentinels = [key, header, password, query, baseUrl]
    const fixture = proxyFixture(
      async function* (request, context) {
        expect(context.endpoint.apiKey).toBe(key)
        expect(context.endpoint.headers?.["X-Private"]).toBe(`Bearer ${header}`)
        yield { type: "text.delta", text: key.slice(0, 7) }
        yield { type: "text.delta", text: key.slice(7) }
        yield {
          type: "serverTool",
          block: {
            type: "serverTool",
            id: "search-1",
            name: "web_search",
            input: { [header]: query },
            status: "done",
            sources: [{ url: baseUrl }],
            signature: { dialect: "fixture", value: password },
          },
        }
        yield {
          type: "error",
          error: { message: sentinels.join(" "), code: header, host: baseUrl, kind: "auth", status: 401 },
          retryable: false,
          message: {
            role: "assistant",
            model: { provider: request.model.provider, model: request.model.id },
            content: [
              { type: "thinking", text: key, signature: { dialect: "fixture", value: password } },
              { type: "text", text: sentinels.join(" "), citations: [{ url: baseUrl }] },
            ],
            stopReason: "error",
          },
        }
      },
      1000,
      {
        methods: ["native"],
        layouts: ["tail"],
        midTurn: true,
        official: () => true,
        async compact() {
          return { ok: true, value: sentinels.join(" "), summary: header, usage: emptyUsage() }
        },
      },
      1000,
      {
        providers: [
          {
            id: "p",
            dialect: "fixture",
            baseUrl,
            ...(source === "literal" ? { apiKey: key } : { apiKeyEnv: "MODEL_KEY" }),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: exercise provider header interpolation
            headers: { "X-Private": "Bearer ${PRIVATE_HEADER}" },
          },
        ],
        env: { ...(source === "environment" ? { MODEL_KEY: key } : {}), PRIVATE_HEADER: header },
        apiKeys: source === "stored" ? { p: key } : {},
      },
    )
    try {
      await fixture.connect()
      const events = await collectEvents(fixture.proxy.stream(fixture.request))
      expect(events.at(-1)?.type).toBe("error")
      const result = await fixture.proxy.compact(fixture.request)
      expect(result.ok).toBe(true)
      const remoteState = JSON.stringify({
        providers: fixture.proxy.providers(),
        model: fixture.proxy.model("p/m"),
        events,
        result,
      })
      const variants = sentinels.flatMap((value) => [
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString("base64"),
      ])
      for (const frame of fixture.observed) {
        for (const sentinel of variants) expect(frame).not.toContain(sentinel)
      }
      for (const sentinel of variants) {
        expect(fixture.observed.join("")).not.toContain(sentinel)
        expect(remoteState).not.toContain(sentinel)
      }
    } finally {
      fixture.close()
    }
  })
}
