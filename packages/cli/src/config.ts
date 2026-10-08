import type { ProviderConfig } from "@amira/ai"
import type { Settings, SettingsLayers, ShellMode } from "@amira/api"
import { DEFAULT_DISABLED_TOOLS, DEFAULT_SHELL } from "@amira/api"
import {
  amiraHome,
  authFile,
  loadAuth,
  loadSettings,
  ProviderSettingsError,
  providersFromSettings,
  type ResolvedPermissions,
  resolvePermissions,
} from "@amira/core"
import { projectScopeIsUser, projectTrust } from "@amira/packages"
import type { CliArgs } from "./args.ts"

export interface Config {
  settings: Settings
  /** Explicit settings values by source layer, for extensions that need provenance. */
  settingsLayers: SettingsLayers
  /** The providers in settings; Amira has no others. */
  providers: ProviderConfig[]
  /** Keys from auth.json, used when the environment has none. */
  apiKeys: Record<string, string>
  /** The permission mode and rules from every settings layer and --permission-mode. */
  permissions: ResolvedPermissions
  /** Which shell tools the model gets (D68), after falling back from powershell off Windows. */
  shell: ShellMode
  /** Explicit tools hidden from the model; shell filtering is applied after tool traits load. */
  disabledTools: string[]
  /** The names the user asked to disable, and where: reported if no tool has them. */
  requestedDisabled: { names: string[]; from: string }
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
    ...(args.thinking ? { thinking: args.thinking } : {}),
    ...(args.shell ? { shell: args.shell } : {}),
    ...(args.disabledTools ? { tools: { disabled: args.disabledTools } } : {}),
    ...(args.permissionMode ? { permissions: { mode: args.permissionMode } } : {}),
  }
  const {
    settings,
    warnings,
    layers: settingsLayers,
    permissions: permissionLayers,
  } = loadSettings({
    cwd: args.cwd,
    home,
    flags,
  })
  // A project's allow rules count once the user trusts the project (amira ext trust), as its packages do.
  const where = { cwd: args.cwd, home }
  const trusted = projectScopeIsUser(where) || projectTrust(args.cwd, settings) === true
  const permissions = resolvePermissions(permissionLayers, { trusted })
  warnings.push(...permissions.warnings)
  const auth = loadAuth(authFile(home), platform)
  let shell: ShellMode = settings.shell ?? DEFAULT_SHELL
  if (shell === "powershell" && platform !== "win32") {
    warnings.push('settings: shell "powershell" is only available on Windows; using auto')
    shell = "auto"
  }
  return {
    settings,
    settingsLayers,
    providers: settingsProviders(settings, warnings),
    apiKeys: auth.keys,
    permissions,
    shell,
    disabledTools: settings.tools?.disabled ?? [...DEFAULT_DISABLED_TOOLS],
    requestedDisabled: {
      names: settings.tools?.disabled ?? [...DEFAULT_DISABLED_TOOLS],
      from: args.disabledTools ? "--disable-tools" : "settings tools.disabled",
    },
    warnings: [...warnings, ...auth.warnings],
  }
}

/**
 * The error for an incomplete provider is thrown before any warning is shown, so it
 * carries the warnings about that provider's keys a project file was not allowed to set.
 */
function settingsProviders(settings: Settings, warnings: string[]): ProviderConfig[] {
  try {
    return providersFromSettings(settings.providers, warnings)
  } catch (err) {
    if (!(err instanceof ProviderSettingsError)) throw err
    const related = warnings.filter((w) => w.includes(`"providers.${err.provider}.`))
    if (!related.length) throw err
    throw new ProviderSettingsError(err.provider, [err.message, ...related].join("\n"))
  }
}
