import type { ProviderConfig } from "@amira/ai"
import type { Settings, ShellMode } from "@amira/api"
import { amiraHome, authFile, loadAuth, loadSettings, providersFromSettings } from "@amira/core"
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
    providers: providersFromSettings(settings.providers),
    apiKeys: auth.keys,
    disabledTools: toolsToDisable(shell, settings.tools?.disabled ?? []),
    warnings: [...warnings, ...auth.warnings],
  }
}
