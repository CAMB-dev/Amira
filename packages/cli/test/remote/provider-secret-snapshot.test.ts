import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi } from "@amira/ai"
import { resolvedEndpointCredentials } from "@amira/ai/local"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"

const approval = {
  provider: "p",
  localProvider: "p",
  dialect: "openai-chat",
  endpointOrigin: "https://provider.invalid",
}

function representations(value: string) {
  return [
    value,
    encodeURIComponent(value),
    Buffer.from(value).toString("base64"),
    JSON.stringify(value).slice(1, -1),
  ]
}

for (const source of ["literal", "environment", "stored"] as const) {
  test(`${source} key and adjacent padded header facts retain raw, HTTP, token and encoded forms locally`, () => {
    const key = `SENTINEL_${source}@API_KEY`
    const prefix = " \tBearer\t"
    const token = ` SENTINEL_${source}@HEADER\tPART  TWO \t`
    const ai = createAi({
      providers: [
        {
          id: "p",
          dialect: approval.dialect,
          baseUrl: `${approval.endpointOrigin}/v1`,
          ...(source === "literal" ? { apiKey: key } : { apiKeyEnv: "MODEL_KEY" }),
          // biome-ignore lint/suspicious/noTemplateCurlyInString: adjacent padded substitution regression
          headers: { "X-Private": "${PREFIX}${TOKEN}" },
        },
      ],
      env: { PREFIX: prefix, TOKEN: token, ...(source === "environment" ? { MODEL_KEY: key } : {}) },
      apiKeys: source === "stored" ? { p: key } : {},
    })
    const bindings = new ProviderBindings(ai, [approval])
    const secrets = bindings.resolve(approval).secrets
    const effective = new Headers({ "X-Private": prefix + token }).get("X-Private")!
    const collapsed = effective.replace(/[ \t]+/g, " ")
    for (const fact of [
      key,
      prefix,
      token,
      token.trim(),
      prefix + token,
      effective,
      collapsed,
      `SENTINEL_${source}@HEADER PART TWO`,
    ])
      for (const value of representations(fact)) expect(secrets).toContain(value)
    expect(resolvedEndpointCredentials(ai.providerEndpoint("p"))).toEqual([prefix, token])
    expect(JSON.stringify(ai.providers())).not.toContain(token)
  })
}

test("literal headers use real HTTP trimming, not Unicode string trimming, and expand extracted tokens", () => {
  for (const header of [
    " \tSENTINEL@LITERAL_HEADER \t",
    " \tBasic\tSENTINEL@BASIC_TOKEN \t",
    " \tToken\tSENTINEL@TOKEN_SCHEME \t",
    " \tbEaReR\tSENTINEL@BEARER_TOKEN \t",
    "\t\u00a0SENTINEL@HTTP_NOT_UNICODE_WHITESPACE\u00a0\t",
  ]) {
    const ai = createAi({
      providers: [
        {
          id: "p",
          dialect: approval.dialect,
          baseUrl: approval.endpointOrigin,
          headers: { "X-Private": header },
        },
      ],
      env: {},
    })
    const secrets = new ProviderBindings(ai, [approval]).resolve(approval).secrets
    const http = new Headers({ "X-Private": header }).get("X-Private")!
    const collapsed = http.replace(/[ \t]+/g, " ")
    const token = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(collapsed)?.[1]
    for (const fact of [header, http, collapsed, ...(token ? [token] : [])])
      for (const value of representations(fact)) expect(secrets).toContain(value)
    expect(secrets).not.toContain("")
  }
})

test("percent-decoding precedes HTTP normalization, token extraction and encoding expansion", () => {
  const header = " %42earer%09SENTINEL%40DECODED_HEADER%20 "
  const ai = createAi({
    providers: [
      {
        id: "p",
        dialect: approval.dialect,
        baseUrl: approval.endpointOrigin,
        headers: { "X-Private": header },
      },
    ],
    env: {},
  })
  const secrets = new ProviderBindings(ai, [approval]).resolve(approval).secrets
  for (const fact of [
    header,
    header.trim(),
    " Bearer\tSENTINEL@DECODED_HEADER  ",
    "Bearer\tSENTINEL@DECODED_HEADER",
    "Bearer SENTINEL@DECODED_HEADER",
    "SENTINEL@DECODED_HEADER",
  ])
    for (const value of representations(fact)) expect(secrets).toContain(value)
})

for (const field of ["userinfo", "query"] as const) {
  test(`URL ${field} raw and decoded facts keep all supported encodings in the same snapshot`, () => {
    const username = "SENTINEL@USERNAME"
    const credential = 'SENTINEL@URL_"CREDENTIAL'
    const baseUrl =
      field === "userinfo"
        ? `https://${encodeURIComponent(username)}:${encodeURIComponent(credential)}@provider.invalid/v1`
        : `${approval.endpointOrigin}/v1?token=${encodeURIComponent(credential)}`
    const ai = createAi({ providers: [{ id: "p", dialect: approval.dialect, baseUrl }], env: {} })
    const secrets = new ProviderBindings(ai, [approval]).resolve(approval).secrets
    for (const fact of field === "userinfo" ? [username, credential] : [credential])
      for (const form of [fact, encodeURIComponent(fact)])
        for (const value of representations(form)) expect(secrets).toContain(value)
  })
}

test("an approved fingerprint reuses one immutable expanded secret set but never accepts changed facts", () => {
  const env = { PREFIX: "SENTINEL_PREFIX", TOKEN: " SENTINEL_TOKEN " }
  const ai = createAi({
    providers: [
      {
        id: "p",
        dialect: approval.dialect,
        baseUrl: approval.endpointOrigin,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: test identical assembled values with changed facts
        headers: { "X-Private": "${PREFIX}${TOKEN}" },
      },
    ],
    env,
  })
  const bindings = new ProviderBindings(ai, [approval])
  const first = bindings.resolve(approval)
  expect(bindings.resolve(approval).secrets).toBe(first.secrets)
  expect(Object.isFrozen(first.secrets)).toBe(true)
  env.PREFIX += " "
  env.TOKEN = env.TOKEN.slice(1)
  expect(ai.providerEndpoint("p").headers?.["X-Private"]).toBe("SENTINEL_PREFIX SENTINEL_TOKEN ")
  expect(() => bindings.resolve(approval)).toThrow()
  const revision = bindings.approve(approval)
  expect(bindings.resolve(approval).revision).toBe(revision)
  expect(bindings.resolve(approval).secrets).not.toBe(first.secrets)
  expect(first.secrets).toContain(" SENTINEL_TOKEN ")
  bindings.revoke("p")
  expect(() => bindings.resolve(approval)).toThrow()
})
