import type { ProviderConfig } from "@amira/ai"
import type { Settings, ShellMode } from "@amira/api"
import { amiraHome, authFile, loadAuth, loadSettings, ProviderSettingsError, providersFromSettings } from "@amira/core"
import type { CliArgs } from "./args.ts"
import { toolsToDisable } from "./session.ts"

export interface Config {
  settings: Settings
  /** Settings providers, merged over the built-ins by createAi. */
  providers: ProviderConfig[]
  /** Keys from auth.json, used when the environment has none. */
  apiKeys: Record<string, string>
  /** Tools hidden from the model, from the shell mode and tools.disabled. */
  disabledTools: string[]
  warnings: string[]
}

/**
 * Settings files, auth.json and the flags combined. The flags (with $AMIRA_MODEL behind
 * --model) are the top settings layer.
 */
export function resolveConfig(
  args: CliArgs,
  home = amiraHome(),
  platform: string = process.platform,
): Config {
  const flags: Settings = {
    ...(args.model ? { model: args.model } : {}),
    ...(args.shell ? { shell: args.shell } : {}),
    ...(args.disabledTools ? { tools: { disabled: args.disabledTools } } : {}),
  }
  const { settings, warnings } = loadSettings({ cwd: args.cwd, home, flags })
  const auth = loadAuth(authFile(home), platform)
  let shell: ShellMode = settings.shell ?? "auto"
  if (shell === "powershell" && platform !== "win32") {
    warnings.push('settings: shell "powershell" is only available on Windows; using auto')
    shell = "auto"
  }
  return {
    settings,
    providers: settingsProviders(settings, warnings),
    apiKeys: auth.keys,
    disabledTools: toolsToDisable(shell, settings.tools?.disabled ?? []),
    warnings: [...warnings, ...auth.warnings],
  }
}

/**
 * The error for an incomplete provider is thrown before any warning is shown, so it
 * carries the warnings about that provider's keys a project file was not allowed to set.
 */
function settingsProviders(settings: Settings, warnings: string[]): ProviderConfig[] {
  try {
    return providersFromSettings(settings.providers)
  } catch (err) {
    if (!(err instanceof ProviderSettingsError)) throw err
    const related = warnings.filter((w) => w.includes(`"providers.${err.provider}.`))
    if (!related.length) throw err
    throw new ProviderSettingsError(err.provider, [err.message, ...related].join("\n"))
  }
}
