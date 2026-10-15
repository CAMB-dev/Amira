import type { ModelSettings, ProviderSettings } from "./settings.ts"

/** Where a provider's API key comes from. */
export type ProviderKeySource = "auth" | "env" | "none"

/** A vendor from the model catalog, with a protocol and endpoint when supported. */
export interface ProviderVendor {
  id: string
  name: string
  env: string[]
  dialect?: string
  baseUrl?: string
  /** Model ids available in the cached catalog. */
  models?: string[]
}

/** A provider as `/provider add` and `/provider edit` fill it in. */
export interface ProviderDraft {
  id: string
  /** Catalog identity; an explicit own id resets a prior override, false disables matching. */
  catalogId?: string | false
  dialect: string
  baseUrl: string
  /** auth: stored in ~/.amira/auth.json; env: read from `apiKeyEnv`; none: no key (a local server). */
  keySource: ProviderKeySource
  /** keySource auth: a key to store; blank or unset keeps the live configured key on edit. Never persisted elsewhere. */
  apiKey?: string
  /** keySource env: the variable holding the key. */
  apiKeyEnv?: string
  /** Variables tried in order when the primary variable is unset; omitted keeps existing fallbacks. */
  apiKeyEnvFallbacks?: string[]
  /** Custom request headers; omitted keeps existing headers. */
  headers?: Record<string, string>
  /** Protocol compatibility settings; omitted keeps existing settings. */
  compat?: ProviderSettings["compat"]
  /**
   * Per-model settings by model id. Unrelated overrides are retained; an included model's
   * `fast` replaces its old descriptor (omitting `fast` restores catalog/default behavior).
   * Omitting modelOverrides keeps every existing override.
   */
  modelOverrides?: Record<string, ModelSettings>
  /** Model ids to offer (e.g. in /model completion). */
  models: string[]
  /** Used for models the catalog does not describe. */
  defaults?: {
    contextWindow?: number
    maxOutput?: number
    thinking?: boolean
    images?: boolean
    promptCache?: boolean
  }
}

/** A model as the provider lists it, with what the catalog knows. */
export interface ProviderModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxOutput?: number
  /** USD per million tokens. */
  cost?: { input: number; output: number }
  /** The model catalog describes it; otherwise the provider's defaults apply. */
  inCatalog: boolean
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  /** Fit to show; never holds the key. */
  message: string
}

/**
 * Managing the configured providers (settings.json `providers`, keys in auth.json), for
 * /provider. There are no built-in providers: only the ones added here or in settings.json
 * exist. Keys never come back out: only a hint of the last characters of a stored one.
 */
export interface ProviderAdmin {
  /** Catalog vendors; the host fetches once if missing. onLoading runs before that fetch starts. */
  vendors?(opts?: { onLoading?: () => void }): Promise<ProviderVendor[]>
  /** Vendors already in memory; never fetches or waits for the catalog. */
  cachedVendors?(): ProviderVendor[]
  /** The exact settings entry save would write, including retained unknown keys, without an API key. */
  preview?(draft: ProviderDraft): ProviderSettings
  /** The dialects (protocols) providers can speak. */
  dialects(): string[]
  /** A provider configured now. */
  exists(id: string): boolean
  /** A configured provider as a draft to edit, without its key. */
  draft(id: string): ProviderDraft | undefined
  /** "…abcd" when auth.json holds a key for the provider. */
  storedKeyHint(id: string): string | undefined
  /** Whether an environment variable is set; its value never leaves the host. */
  envIsSet(name: string): boolean
  /** Asks the provider for its models, with the draft's key; rejects with a message to show. */
  listModels(draft: ProviderDraft, signal?: AbortSignal): Promise<ProviderModelInfo[]>
  /** What the catalog says about these model ids for this provider. */
  describeModels(draft: ProviderDraft, ids: string[]): ProviderModelInfo[]
  /** Sends one tiny request to `model`. */
  test(draft: ProviderDraft, model: string, signal?: AbortSignal): Promise<ProviderTestResult>
  /** Writes settings and credentials. persistKeySource defaults to true; false preserves legacy flags-only output. */
  save(draft: ProviderDraft, opts?: { persistKeySource?: boolean }): Promise<string>
  /** Removes the provider from the user settings, and its stored key when asked. */
  remove(id: string, opts: { removeKey: boolean }): Promise<string>
  /** Stores a new key for the provider in auth.json and uses it at once. */
  setKey(id: string, apiKey: string): Promise<string>
}

/** "provider/model", or "(no model)" while none is selected (NO_MODEL has no provider). */
export function modelLabel(m: { provider: string; model: string }): string {
  return m.provider ? `${m.provider}/${m.model}` : "(no model)"
}
