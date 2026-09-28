import { BUILTIN_PROVIDERS, findPreset, type ProviderConfig } from "@amira/ai"
import type { ProviderSettings } from "@amira/api"
import { deepMerge } from "./merge.ts"

export class ProviderSettingsError extends Error {}

/**
 * Providers from settings (D54). An entry for a built-in id is merged over it; any other
 * entry must name its dialect and baseUrl.
 */
export function providersFromSettings(
  entries: Record<string, ProviderSettings> = {},
  builtins: ProviderConfig[] = BUILTIN_PROVIDERS,
): ProviderConfig[] {
  return Object.entries(entries).map(([id, entry]) => {
    const merged = deepMerge<ProviderConfig>(
      builtins.find((b) => b.id === id) ?? ({ id } as ProviderConfig),
      entry,
    )
    merged.id = id
    const missing = (["dialect", "baseUrl"] as const).filter((k) => !merged[k])
    if (missing.length) {
      const hint = findPreset(id)
        ? `; run "amira provider add ${id}" for a ready-made entry`
        : '; see "amira provider presets" for examples'
      throw new ProviderSettingsError(
        `provider "${id}" in settings needs ${missing.map((k) => `"${k}"`).join(" and ")}${hint}`,
      )
    }
    return merged
  })
}
