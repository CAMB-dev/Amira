import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi } from "@amira/ai"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"
import { collectEvents, proxyFixture } from "./model-proxy-fixture.ts"

const prefix = "SENTINEL_HEADER_PREFIX"
const token = "SENTINEL_HEADER_TOKEN"
// biome-ignore lint/suspicious/noTemplateCurlyInString: exercise adjacent local substitutions
const headers = { "X-Credential": "${PREFIX}${TOKEN}" }
const approval = {
  provider: "p",
  localProvider: "p",
  dialect: "fixture",
  endpointOrigin: "https://provider.invalid",
}

test("adjacent header substitutions supply individual exact local redaction facts", () => {
  const ai = createAi({
    providers: [{ id: "p", dialect: "fixture", baseUrl: approval.endpointOrigin, headers }],
    env: { PREFIX: prefix, TOKEN: token },
  })
  const bindings = new ProviderBindings(ai, [approval])
  expect(bindings.resolve(approval).secrets).toContain(prefix)
  expect(bindings.resolve(approval).secrets).toContain(token)
})

test("changing substitution boundaries with an unchanged assembled header invalidates approval", () => {
  const env = { PREFIX: prefix, TOKEN: token }
  const ai = createAi({
    providers: [{ id: "p", dialect: "fixture", baseUrl: approval.endpointOrigin, headers }],
    env,
  })
  const bindings = new ProviderBindings(ai, [approval])
  env.PREFIX = prefix + token.slice(0, 5)
  env.TOKEN = token.slice(5)
  expect(() => bindings.resolve(approval)).toThrow()
})

for (const field of ["userinfo", "query"] as const) {
  test(`decoded URL ${field} credentials include every supported representation`, () => {
    const decoded = "SENTINEL@PASSWORD"
    const raw = encodeURIComponent(decoded)
    const baseUrl =
      field === "userinfo"
        ? `https://user:${raw}@provider.invalid/v1`
        : `https://provider.invalid/v1?token=${raw}`
    const ai = createAi({ providers: [{ id: "p", dialect: "fixture", baseUrl }], env: {} })
    const secrets = new ProviderBindings(ai, [approval]).resolve(approval).secrets
    for (const literal of [raw, decoded]) {
      for (const value of [literal, encodeURIComponent(literal), Buffer.from(literal).toString("base64")])
        expect(secrets).toContain(value)
    }
  })
}

test("adjacent substitutions and decoded URL representations stay out of stream, compact and receipt frames", async () => {
  const decoded = "SENTINEL@URL_PASSWORD"
  const encoded = Buffer.from(decoded).toString("base64")
  const echo = `${prefix} ${token} ${encoded}`
  const fixture = proxyFixture(
    async function* (request) {
      yield { type: "text.delta", text: echo }
      yield {
        type: "done",
        message: {
          role: "assistant",
          model: { provider: request.model.provider, model: request.model.id },
          content: [{ type: "text", text: echo }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, serviceTier: token },
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
        return {
          ok: true,
          value: echo,
          summary: echo,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, serviceTier: token },
        }
      },
    },
    1000,
    {
      providers: [
        {
          id: "p",
          dialect: "fixture",
          baseUrl: `https://user:${encodeURIComponent(decoded)}@provider.invalid/v1`,
          headers,
        },
      ],
      env: { PREFIX: prefix, TOKEN: token },
    },
  )
  try {
    await fixture.connect()
    const events = await collectEvents(fixture.proxy.stream(fixture.request))
    const result = await fixture.proxy.compact(fixture.request)
    expect(result.ok).toBe(true)
    expect(fixture.observed.some((frame) => frame.includes('"receipt"'))).toBe(true)
    const outbound = JSON.stringify({ events, result, frames: fixture.observed })
    for (const secret of [prefix, token, encoded]) expect(outbound).not.toContain(secret)
  } finally {
    fixture.close()
  }
})
