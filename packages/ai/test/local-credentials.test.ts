import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { resolvedEndpointCredentials } from "../src/local.ts"

test("local credential facts capture exact substitutions, including adjacent values and fallbacks", () => {
  const env = { PREFIX: "synthetic-prefix", TOKEN: " synthetic token ", EMPTY: "" }
  const ai = createAi({
    env,
    providers: [
      {
        id: "p",
        dialect: "openai-chat",
        baseUrl: "https://provider.invalid",
        headers: {
          "X-Adjacent": `\${PREFIX}\${TOKEN}`,
          "X-Fallback": `\${EMPTY:-fallback-secret}`,
          "X-Empty": `\${ABSENT}`,
        },
      },
    ],
  })
  const endpoint = ai.providerEndpoint("p")
  expect(resolvedEndpointCredentials(endpoint)).toEqual([env.PREFIX, env.TOKEN, "fallback-secret"])
  expect(Object.keys(endpoint).sort()).toEqual(["baseUrl", "credentialSource", "dialect", "headers"])
  expect(JSON.stringify(ai.providers())).not.toContain(env.TOKEN)
  env.TOKEN = "rotated"
  expect(resolvedEndpointCredentials(ai.providerEndpoint("p"))).toEqual([
    env.PREFIX,
    "rotated",
    "fallback-secret",
  ])
  expect(resolvedEndpointCredentials(endpoint)).toContain(" synthetic token ")
})

test("reusing resolved endpoint headers preserves exact facts without expanding nested placeholders", () => {
  const literal = `secret-\${NESTED}`
  const original = createAi({
    providers: [
      {
        id: "p",
        dialect: "openai-chat",
        baseUrl: "https://provider.invalid",
        headers: { "X-Secret": `\${TOKEN}` },
      },
    ],
    env: { TOKEN: literal },
  })
  const endpoint = original.providerEndpoint("p")
  const probe = createAi({
    providers: [{ id: "p", ...endpoint }],
    env: { NESTED: "must-not-expand" },
  })
  expect(probe.providerEndpoint("p").headers).toEqual({ "X-Secret": literal })
  expect(resolvedEndpointCredentials(probe.providerEndpoint("p"))).toEqual([literal])
  expect(resolvedEndpointCredentials({ headers: { "X-Secret": "custom-static" } })).toEqual([])
})
