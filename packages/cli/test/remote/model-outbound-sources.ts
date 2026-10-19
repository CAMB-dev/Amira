import { type AiOptions, createAi } from "@amira/ai"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"

type Credentials = Pick<AiOptions, "providers" | "env" | "apiKeys">
export interface CredentialSource {
  name: string
  secrets: readonly string[]
  variants: readonly string[]
}

/** Independent expectations: do not derive the test oracle using secretVariants(). */
function representations(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .flatMap((value) => [
          value,
          encodeURIComponent(value),
          Buffer.from(value).toString("base64"),
          JSON.stringify(value).slice(1, -1),
        ]),
    ),
  ]
}

/** Short probes bound the exhaustive product; escaping and HTTP padding remain real. */
export function credentialSources(): CredentialSource[] {
  const origin = "https://provider.invalid"
  const provider = { id: "p", dialect: "fixture", baseUrl: origin }
  const cases: { name: string; credentials: Credentials; facts: string[] }[] = [
    { name: "literal API key", credentials: { providers: [{ ...provider, apiKey: 'K"Z' }] }, facts: ['K"Z'] },
    {
      name: "environment API key",
      credentials: { providers: [{ ...provider, apiKeyEnv: "KEY" }], env: { KEY: "E~" } },
      facts: ["E~"],
    },
    { name: "stored API key", credentials: { providers: [provider], apiKeys: { p: "S~" } }, facts: ["S~"] },
    {
      name: "header placeholder",
      credentials: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: resolved local provider template
        providers: [{ ...provider, headers: { "X-Private": "${TOKEN}" } }],
        env: { TOKEN: "H~" },
      },
      facts: ["H~"],
    },
    {
      name: "adjacent header placeholders",
      credentials: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: individual substitution boundaries matter
        providers: [{ ...provider, headers: { "X-Private": "${LEFT}${RIGHT}" } }],
        env: { LEFT: "L~", RIGHT: "R~" },
      },
      facts: ["L~", "R~", "L~R~"],
    },
    {
      name: "padded placeholder HTTP header",
      credentials: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HTTP normalization follows interpolation
        providers: [{ ...provider, headers: { Authorization: "${PAD}" } }],
        env: { PAD: " Bearer Z " },
      },
      facts: [" Bearer Z ", "Bearer Z", "Z"],
    },
    {
      name: "literal padded HTTP header",
      credentials: { providers: [{ ...provider, headers: { "X-Private": "\tZ\t" } }] },
      facts: ["\tZ\t", "Z"],
    },
    {
      name: "URL userinfo",
      credentials: { providers: [{ ...provider, baseUrl: "https://%40:%21@provider.invalid" }] },
      facts: ["%40", "@", "%21", "!"],
    },
    {
      name: "URL query",
      credentials: { providers: [{ ...provider, baseUrl: `${origin}?token=%3F` }] },
      facts: ["%3F", "?"],
    },
  ]
  return cases.map(({ name, credentials, facts }) => {
    const ai = createAi({ ...credentials, env: credentials.env ?? {}, retry: { retries: 0 } })
    const approval = { provider: "p", localProvider: "p", dialect: "fixture", endpointOrigin: origin }
    const secrets = new ProviderBindings(ai, [approval]).resolve(approval).secrets
    const variants = representations(facts)
    for (const variant of variants) {
      if (!secrets.includes(variant))
        throw new Error(`${name}: missing canonical credential representation ${JSON.stringify(variant)}`)
    }
    return { name, secrets, variants }
  })
}
