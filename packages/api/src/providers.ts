/** Where a provider's API key comes from. */
export type ProviderKeySource = "auth" | "env" | "none"

/** A provider as `/provider add` and `/provider edit` fill it in. */
export interface ProviderDraft {
  id: string
  dialect: string
  baseUrl: string
  /** auth: stored in ~/.amira/auth.json; env: read from `apiKeyEnv`; none: no key (a local server). */
  keySource: ProviderKeySource
  /** keySource auth: a key to store; empty or unset keeps the stored one. Never persisted elsewhere. */
  apiKey?: string
  /** keySource env: the variable holding the key. */
  apiKeyEnv?: string
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
  /** The dialects (protocols) providers can speak; adding a provider starts by picking one. */
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
  /** Writes the provider to the user settings (and its key to auth.json) and makes it usable at once. */
  save(draft: ProviderDraft): Promise<string>
  /** Removes the provider from the user settings, and its stored key when asked. */
  remove(id: string, opts: { removeKey: boolean }): Promise<string>
  /** Stores a new key for the provider in auth.json and uses it at once. */
  setKey(id: string, apiKey: string): Promise<string>
}
