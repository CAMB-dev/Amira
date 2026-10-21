import { createAi } from "@amira/ai"
import { resolveRemoteSettings } from "@amira/core"
import type { Config } from "../config.ts"
import { ProxyAi } from "../remote/proxy-ai.ts"
import type { ServerAiRoute } from "../server-main.ts"

/** No credential store/environment lookup in the default route, even during metadata discovery. */
export function configuredServerAi(config: Config, mode: "proxy" | "remote-key"): ServerAiRoute {
  if (mode === "remote-key") {
    return { mode, ai: createAi({ providers: config.providers, apiKeys: config.apiKeys }) }
  }
  const metadataAi = createAi({
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: undefined,
      apiKeyEnv: undefined,
      apiKeyEnvFallbacks: [],
      keySource: "none",
      headers: undefined,
    })),
    env: {},
  })
  const refs = new Set([
    ...config.providers.flatMap((provider) => (provider.models ?? []).map((m) => `${provider.id}/${m.id}`)),
    ...(config.settings.model ? [config.settings.model] : []),
    ...(config.settings.compact?.model ? [config.settings.compact.model] : []),
    ...Object.values(config.settings.agents ?? {}).flatMap((agent) => (agent.model ? [agent.model] : [])),
  ])
  const ai = new ProxyAi(
    [...refs].map((ref) => {
      const model = metadataAi.model(ref)
      return {
        model,
        revision: "unbound",
        available: false,
        replay: metadataAi.replayTarget(model),
      }
    }),
    {
      reconnectTimeoutMs: resolveRemoteSettings(config.settings).proxyReconnectTimeoutMs,
      origins: config.providers.map((provider) => ({
        provider: provider.id,
        origin: new URL(metadataAi.providerEndpoint(provider.id).baseUrl).origin,
      })),
    },
  )
  // The local binding negotiation must supply approved broker metadata before model admission.
  return { mode, ai }
}
