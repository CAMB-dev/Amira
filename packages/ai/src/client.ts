import { catalogProviderId, type ModelCatalog } from "./catalog.ts"
import { withCost } from "./cost.ts"
import type { Dialect } from "./dialect.ts"
import { BUILTIN_DIALECTS } from "./dialects/index.ts"
import { isNoModel, type ProviderConfig, resolveModelInfo } from "./providers.ts"
import { type RetryOptions, withRetry } from "./retry.ts"
import { withTextTools } from "./text-tools.ts"
import { type ModelInfo, type ModelRequest, type StreamEvent, withoutDisplay } from "./types.ts"

export interface AiOptions {
  providers?: ProviderConfig[]
  dialects?: Dialect[]
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  /** Stored API keys by provider id (e.g. from auth.json), used when the key variables are unset. */
  apiKeys?: Record<string, string>
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
  /** Whether a request to this provider would have an API key, or needs none (e.g. a local server). */
  hasKey(providerId: string): boolean
  /**
   * "provider/model" refs worth offering, e.g. for completion: the models each provider lists
   * and the catalog's models for it, from providers that have a key or need none.
   */
  knownModels(): string[]
  /** Replaces the catalog, e.g. after a refresh; affects models resolved from now on. */
  setCatalog?(catalog: ModelCatalog | undefined): void
  /** The catalog in use, if any. */
  catalog?(): ModelCatalog | undefined
  /** Forgets a provider. */
  removeProvider?(id: string): void
  /** Sets or (undefined) forgets the stored key (auth.json) used for a provider when its variables are unset. */
  setStoredKey?(id: string, apiKey: string | undefined): void
}

export function createAi(opts: AiOptions = {}): Ai {
  const providers = new Map<string, ProviderConfig>()
  const dialects = new Map<string, Dialect>()
  // Only the providers given exist: Amira has none built in, just the dialects to speak to them.
  for (const p of opts.providers ?? []) providers.set(p.id, p)
  for (const d of [...BUILTIN_DIALECTS, ...(opts.dialects ?? [])]) dialects.set(d.id, d)
  const env = opts.env ?? process.env
  const doFetch = opts.fetch ?? fetch
  let catalog = opts.catalog
  // A copy, so keys stored or deleted later (/provider) change what requests use.
  // Null-prototype, so ids such as "constructor" never find Object's members.
  const storedKeys: Record<string, string> = Object.assign(Object.create(null), opts.apiKeys)

  const hasKey = (p: ProviderConfig) =>
    !p.apiKeyEnv || Boolean(p.apiKey ?? keyFromEnv(p, env) ?? storedKeys[p.id])

  const unknownProvider = (id: string) => {
    const ids = [...providers.keys()]
    const known = ids.length > 0 ? `configured: ${ids.join(", ")}` : "no providers are configured"
    return `unknown provider "${id}" (${known})`
  }

  const provider = (id: string) => {
    const p = providers.get(id)
    if (!p) throw new Error(unknownProvider(id))
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
    stream(full, signal) {
      // A message's display is for frontends; the model only ever sees its content.
      const req = withoutDisplay(full)
      if (isNoModel(req.model)) {
        const message =
          providers.size === 0
            ? "no providers configured; add one with /provider add, then pick a model with /model"
            : "no model selected; pick one with /model"
        return failed(req, message, "no_model")
      }
      const p = providers.get(req.model.provider)
      if (!p) return failed(req, unknownProvider(req.model.provider), "unknown_provider")
      const dialect = dialects.get(req.model.dialect)
      if (!dialect) return failed(req, `unknown dialect "${req.model.dialect}"`, "unknown_dialect")
      const apiKey = p.apiKey ?? keyFromEnv(p, env) ?? storedKeys[p.id]
      if (p.apiKeyEnv && !apiKey) {
        const names = [p.apiKeyEnv, ...(p.apiKeyEnvFallbacks ?? [])].join(" or ")
        return failed(req, `${names} is not set; export it to use provider ${p.id}`, "missing_api_key")
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
    hasKey: (id) => {
      const p = providers.get(id)
      return p !== undefined && hasKey(p)
    },
    knownModels() {
      const out = new Set<string>()
      for (const p of providers.values()) {
        if (!hasKey(p)) continue
        for (const m of p.models ?? []) if (m.id) out.add(`${p.id}/${m.id}`)
        const catalogId = catalogProviderId(p)
        for (const id of catalogId ? (catalog?.list?.(catalogId) ?? []) : []) out.add(`${p.id}/${id}`)
      }
      return [...out]
    },
    setCatalog: (c) => {
      catalog = c
    },
    catalog: () => catalog,
    setStoredKey: (id, key) => {
      if (key === undefined) delete storedKeys[id]
      else storedKeys[id] = key
    },
    removeProvider: (id) => void providers.delete(id),
  }
}

function keyFromEnv(p: ProviderConfig, env: Record<string, string | undefined>): string | undefined {
  for (const name of [p.apiKeyEnv, ...(p.apiKeyEnvFallbacks ?? [])]) {
    const value = name ? env[name] : undefined
    if (value) return value
  }
  return undefined
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
