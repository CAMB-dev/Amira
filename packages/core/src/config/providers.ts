import type { ProviderConfig } from "@amira/ai"
import type { ProviderSettings } from "@amira/api"

export class ProviderSettingsError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Where the providers Amira used to have built in connected. Only for settings written back
 * then: an entry with one of these ids that lacks its dialect or baseUrl (because it only
 * tweaked the built-in one) keeps working. Not offered anywhere; new providers name both.
 */
const FORMER_BUILTINS: Record<string, Pick<ProviderConfig, "dialect" | "baseUrl">> = {
  anthropic: { dialect: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  openai: { dialect: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  "openai-chat": { dialect: "openai-chat", baseUrl: "https://api.openai.com/v1" },
  google: { dialect: "google-gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
}

/**
 * Providers from settings (D54). Amira has none built in: each entry names its dialect (the
 * protocol it speaks) and baseUrl.
 */
export function providersFromSettings(
  entries: Record<string, ProviderSettings> = {},
  /** Receives a note for each entry completed from FORMER_BUILTINS. */
  warnings?: string[],
): ProviderConfig[] {
  return Object.entries(entries).map(([id, entry]) => {
    const former = Object.hasOwn(FORMER_BUILTINS, id) ? FORMER_BUILTINS[id] : undefined
    const p = { ...entry, id } as ProviderConfig
    if (former && (!p.dialect || !p.baseUrl)) {
      p.dialect ||= former.dialect
      p.baseUrl ||= former.baseUrl
      // The key variable and other defaults it had are gone; without a key requests fail.
      warnings?.push(
        `provider "${id}" in settings.json lacks "dialect" or "baseUrl", so the former built-in ` +
          `ones (${p.dialect}, ${p.baseUrl}) are used${p.apiKeyEnv ? "" : '; it has no "apiKeyEnv" any more'}. ` +
          `Complete it with "amira provider edit ${id}"`,
      )
    }
    const missing = (["dialect", "baseUrl"] as const).filter((k) => !p[k])
    if (missing.length) {
      throw new ProviderSettingsError(
        id,
        `provider "${id}" in settings.json needs ${missing.map((k) => `"${k}"`).join(" and ")}; ` +
          'fix the entry, or remove it and run "amira provider add"',
      )
    }
    return p
  })
}
