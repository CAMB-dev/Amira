import type { Dialect } from "./dialect.ts"
import { openaiChat } from "./dialects/openai-chat.ts"
import { BUILTIN_PROVIDERS, type ProviderConfig, resolveModelInfo } from "./providers.ts"
import type { ModelInfo, ModelRequest, StreamEvent } from "./types.ts"

export interface AiOptions {
  providers?: ProviderConfig[]
  dialects?: Dialect[]
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
}

export interface Ai {
  /** Resolves "provider/model" (the model id may itself contain slashes). */
  model(ref: string): ModelInfo
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
  registerProvider(p: ProviderConfig): void
  registerDialect(d: Dialect): void
  providers(): ProviderConfig[]
}

export function createAi(opts: AiOptions = {}): Ai {
  const providers = new Map<string, ProviderConfig>()
  const dialects = new Map<string, Dialect>()
  for (const p of [...BUILTIN_PROVIDERS, ...(opts.providers ?? [])]) providers.set(p.id, p)
  for (const d of [openaiChat, ...(opts.dialects ?? [])]) dialects.set(d.id, d)
  const env = opts.env ?? process.env
  const doFetch = opts.fetch ?? fetch

  const provider = (id: string) => {
    const p = providers.get(id)
    if (!p) throw new Error(`unknown provider "${id}" (known: ${[...providers.keys()].join(", ")})`)
    return p
  }

  return {
    model(ref) {
      const slash = ref.indexOf("/")
      if (slash <= 0 || slash === ref.length - 1) {
        throw new Error(`model must look like "provider/model", got "${ref}"`)
      }
      return resolveModelInfo(provider(ref.slice(0, slash)), ref.slice(slash + 1))
    },
    stream(req, signal) {
      const p = providers.get(req.model.provider)
      if (!p) return failed(req, `unknown provider "${req.model.provider}"`, "unknown_provider")
      const dialect = dialects.get(req.model.dialect)
      if (!dialect) return failed(req, `unknown dialect "${req.model.dialect}"`, "unknown_dialect")
      const apiKey = p.apiKey ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined)
      if (p.apiKeyEnv && !apiKey) {
        return failed(req, `${p.apiKeyEnv} is not set; export it to use provider ${p.id}`, "missing_api_key")
      }
      return dialect.stream(req, {
        endpoint: {
          baseUrl: p.baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(p.headers ? { headers: p.headers } : {}),
        },
        signal: signal ?? new AbortController().signal,
        fetch: doFetch,
        ...(p.compat ? { compat: p.compat } : {}),
      })
    },
    registerProvider: (p) => void providers.set(p.id, p),
    registerDialect: (d) => void dialects.set(d.id, d),
    providers: () => [...providers.values()],
  }
}

/** A stream that ends at once with an error, so callers see one failure path. */
async function* failed(req: ModelRequest, message: string, code: string): AsyncGenerator<StreamEvent> {
  yield {
    type: "error",
    error: { message, code },
    retryable: false,
    message: {
      role: "assistant",
      content: [],
      model: { provider: req.model.provider, model: req.model.id },
      stopReason: "error",
    },
  }
}
