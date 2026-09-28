import { catalogProviderId, type ModelCatalog } from "./catalog.ts"
import { withCost } from "./cost.ts"
import type { Dialect } from "./dialect.ts"
import { BUILTIN_DIALECTS } from "./dialects/index.ts"
import { BUILTIN_PROVIDERS, type ProviderConfig, resolveModelInfo } from "./providers.ts"
import { type RetryOptions, withRetry } from "./retry.ts"
import { withTextTools } from "./text-tools.ts"
import type { ModelInfo, ModelRequest, StreamEvent } from "./types.ts"

export interface AiOptions {
  providers?: ProviderConfig[]
  dialects?: Dialect[]
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  /** Model facts (context window, caps, prices) under the provider's own settings (D51). */
  catalog?: ModelCatalog
  /** Retrying failed requests (D52); by default 3 retries, backing off from 1 s. */
  retry?: RetryOptions
}

export interface Ai {
  /** Resolves "provider/model" (the model id may itself contain slashes). */
  model(ref: string): ModelInfo
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
  registerProvider(p: ProviderConfig): void
  registerDialect(d: Dialect): void
  providers(): ProviderConfig[]
  /** Replaces the catalog, e.g. after a refresh; affects models resolved from now on. */
  setCatalog?(catalog: ModelCatalog | undefined): void
}

export function createAi(opts: AiOptions = {}): Ai {
  const providers = new Map<string, ProviderConfig>()
  const dialects = new Map<string, Dialect>()
  for (const p of [...BUILTIN_PROVIDERS, ...(opts.providers ?? [])]) providers.set(p.id, p)
  for (const d of [...BUILTIN_DIALECTS, ...(opts.dialects ?? [])]) dialects.set(d.id, d)
  const env = opts.env ?? process.env
  const doFetch = opts.fetch ?? fetch
  let catalog = opts.catalog

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
      const p = provider(ref.slice(0, slash))
      const id = ref.slice(slash + 1)
      const catalogId = catalogProviderId(p)
      return resolveModelInfo(p, id, catalogId ? catalog?.find(catalogId, id) : undefined)
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
      const sig = signal ?? new AbortController().signal
      const ctx = {
        endpoint: {
          baseUrl: p.baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(p.headers ? { headers: p.headers } : {}),
        },
        signal: sig,
        fetch: doFetch,
        ...(p.compat ? { compat: p.compat } : {}),
      }
      const attempt = () => withTextTools(req, (r) => dialect.stream(r, ctx))
      return withCost(withRetry(attempt, sig, opts.retry), req.model)
    },
    registerProvider: (p) => void providers.set(p.id, p),
    registerDialect: (d) => void dialects.set(d.id, d),
    providers: () => [...providers.values()],
    setCatalog: (c) => {
      catalog = c
    },
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
