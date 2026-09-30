import { catalogProviderId, type ModelCatalog } from "./catalog.ts"
import { usageCost, withCost } from "./cost.ts"
import type { Dialect, DialectContext } from "./dialect.ts"
import { BUILTIN_DIALECTS } from "./dialects/index.ts"
import { modelErrorKind } from "./errors.ts"
import {
  type CompactAttempt,
  CompactionFailures,
  type CompactionMemory,
  type CompactResult,
  endpointKey,
  type NativeCompaction,
} from "./native-compaction.ts"
import { isNoModel, type ProviderConfig, resolveModelInfo } from "./providers.ts"
import { type RetryOptions, sleep, withRetry } from "./retry.ts"
import { withTextTools } from "./text-tools.ts"
import { canReplay, forReplay, type ReplayTarget, withSignatureHost } from "./thinking.ts"
import {
  emptyUsage,
  type ModelInfo,
  type ModelRequest,
  type Signature,
  type StreamEvent,
  type Usage,
  withoutDisplay,
} from "./types.ts"

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
  /** Keeps the ways of server-side compaction that failed as unsupported between runs. */
  compactionMemory?: CompactionMemory
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
  /** Where a request for `model` goes: its dialect, provider, host and model (ReplayTarget). */
  replayTarget(model: ModelInfo): ReplayTarget
  /**
   * Whether a request for `model` would send this signed data back as it is (canReplay);
   * `producer` is the provider of the message that holds it. Requests drop what it cannot.
   */
  canReplay(sig: Signature, model: ModelInfo, producer?: string): boolean
  /**
   * The server-side compaction `model`'s provider offers now: its dialect has one, the provider
   * turns it on (ProviderCompat.compaction; by default only on the vendor's own endpoints), and
   * a way to ask is left that has not failed here as unsupported. Undefined otherwise.
   */
  nativeCompaction(model: ModelInfo): NativeCompaction | undefined
  /**
   * Compacts `req.messages` on the server, trying each way nativeCompaction lists in order
   * and retrying transient failures. A way the endpoint turns out not to support is
   * remembered (compactionMemory) and skipped from then on. Never throws.
   */
  compact(req: ModelRequest, signal?: AbortSignal, onProgress?: () => void): Promise<CompactResult>
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

  /** What a dialect needs to reach the provider, or why no request can be sent. */
  const contextOf = (p: ProviderConfig, signal: AbortSignal): DialectContext | string => {
    const apiKey = p.apiKey ?? keyFromEnv(p, env) ?? storedKeys[p.id]
    if (p.apiKeyEnv && !apiKey) {
      const names = [p.apiKeyEnv, ...(p.apiKeyEnvFallbacks ?? [])].join(" or ")
      return `${names} is not set; export it to use provider ${p.id}`
    }
    return {
      endpoint: {
        baseUrl: p.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(p.headers ? { headers: p.headers } : {}),
      },
      signal,
      fetch: doFetch,
      ...(p.compat ? { compat: p.compat } : {}),
    }
  }

  const failures = new CompactionFailures(opts.compactionMemory)

  /** The provider's server-side compaction for `model`, if it is on and a way is left to try. */
  const nativeCompaction = (model: ModelInfo): NativeCompaction | undefined => {
    const p = providers.get(model.provider)
    const native = dialects.get(model.dialect)?.compaction
    if (!p || !native || isNoModel(model)) return undefined
    const mode = p.compat?.compaction ?? "auto"
    if (mode === "off" || (mode === "auto" && !native.official(p.baseUrl))) return undefined
    const skipped = failures.skipped(endpointKey(p.id, hostOf(p.baseUrl), model.id))
    const methods = native.methods.filter((m) => !skipped.has(m))
    if (!methods.length) return undefined
    return { dialect: model.dialect, methods, layouts: [...native.layouts] }
  }

  /** Tries each way the provider has, in order, until one returns a checkpoint (Ai.compact). */
  const compact = async (
    full: ModelRequest,
    signal: AbortSignal = new AbortController().signal,
    onProgress?: () => void,
  ): Promise<CompactResult> => {
    const usage = emptyUsage()
    const tried: CompactAttempt[] = []
    const model = full.model
    const support = nativeCompaction(model)
    const p = providers.get(model.provider)
    const native = dialects.get(model.dialect)?.compaction
    if (!support || !p || !native) {
      return { ok: false, error: `${model.provider}/${model.id} has no server-side compaction`, usage, tried }
    }
    const ctx = contextOf(p, signal)
    if (typeof ctx === "string") return { ok: false, error: ctx, usage, tried }
    const target = targetOf(p, model)
    const key = endpointKey(p.id, target.host, model.id)
    const req = withoutDisplay(full)
    const sendable = { ...req, messages: forReplay(req.messages, target) }
    const retries = opts.retry?.retries ?? 3
    const base = opts.retry?.baseDelayMs ?? 1000
    const aborted = (): CompactResult => ({ ok: false, error: "aborted", usage, tried, aborted: true })
    for (const method of support.methods) {
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) return aborted()
        const out = await native.compact(method, sendable, ctx, onProgress)
        if (out.usage) addTo(usage, withPrice(out.usage, model))
        if (signal.aborted) return aborted()
        if (out.ok) {
          const checkpoint: Signature = {
            dialect: model.dialect,
            value: out.value,
            kind: "checkpoint",
            provider: p.id,
            host: target.host,
            model: model.id,
          }
          return {
            ok: true,
            checkpoint,
            ...(out.summary?.trim() ? { summary: out.summary.trim() } : {}),
            usage,
            method,
            tried,
          }
        }
        if (out.retryable && !out.unsupported && attempt < retries) {
          if (!(await sleep(base * 2 ** attempt, signal))) return aborted()
          continue
        }
        tried.push({ method, error: out.error.message, unsupported: out.unsupported })
        if (out.unsupported) failures.remember(key, method)
        break
      }
    }
    const error = tried.map((t) => `${t.method}: ${t.error}`).join("; ")
    return { ok: false, error, usage, tried }
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
      const sig = signal ?? new AbortController().signal
      const ctx = contextOf(p, sig)
      if (typeof ctx === "string") return failed(req, ctx, "missing_api_key")
      // Signed reasoning and output items go back only where they came from (canReplay).
      const host = hostOf(p.baseUrl)
      const messages = forReplay(req.messages, targetOf(p, req.model))
      const sendable = messages === req.messages ? req : { ...req, messages }
      const attempt = () => withTextTools(sendable, (r) => dialect.stream(r, ctx))
      const events = withSignatureHost(withRetry(attempt, sig, opts.retry), host)
      return withErrorFacts(withCost(events, req.model), host)
    },
    nativeCompaction,
    compact,
    replayTarget: (model) => {
      const p = providers.get(model.provider)
      return p
        ? targetOf(p, model)
        : { dialect: model.dialect, provider: model.provider, host: "", model: model.id }
    },
    canReplay(sig, model, producer) {
      const p = providers.get(model.provider)
      return p !== undefined && canReplay(sig, targetOf(p, model), producer)
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

/** Usage with its cost at the model's prices, when they are known. */
function withPrice(u: Usage, model: ModelInfo): Usage {
  return model.cost ? { ...u, cost: usageCost(u, model.cost) } : u
}

function addTo(to: Usage, u: Usage) {
  to.input += u.input
  to.output += u.output
  to.cacheRead += u.cacheRead
  to.cacheWrite += u.cacheWrite
  if (u.cost !== undefined) to.cost = (to.cost ?? 0) + u.cost
}

function targetOf(p: ProviderConfig, model: ModelInfo): ReplayTarget {
  return { dialect: model.dialect, provider: p.id, host: hostOf(p.baseUrl), model: model.id }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Errors (and retries) handed out carry their kind and the host the request went to. */
async function* withErrorFacts(
  events: AsyncIterable<StreamEvent>,
  where: string,
): AsyncGenerator<StreamEvent> {
  for await (const ev of events) {
    if (ev.type === "error" || ev.type === "retry") {
      const host = ev.error.host ?? where
      const kind = ev.error.kind ?? modelErrorKind(ev.error)
      yield { ...ev, error: { ...ev.error, ...(host ? { host } : {}), kind } }
    } else yield ev
  }
}

/** A stream that ends at once with an error, so callers see one failure path. */
async function* failed(req: ModelRequest, message: string, code: string): AsyncGenerator<StreamEvent> {
  yield {
    type: "error",
    error: { message, code, kind: "config" },
    retryable: false,
    message: {
      role: "assistant",
      content: [],
      model: { provider: req.model.provider, model: req.model.id },
      stopReason: "error",
    },
  }
}
