import type { Ai } from "@amira/ai"
import { resolveRemoteSettings } from "@amira/core"
import type { ProxyAi } from "./remote/proxy-ai.ts"
import { serverVersionIdentity } from "./remote/release-identity.ts"
import { configuredServerAi } from "./server/configured-ai.ts"
import { version } from "./version.ts"

export type ServerAiRoute = { mode: "proxy"; ai: ProxyAi } | { mode: "remote-key"; ai: Ai }

/** Explicit routing only. A missing local broker never selects remote credentials. */
export async function createServerRuntime(options: {
  cwd: string
  ai?: Ai
  route?: ServerAiRoute
  keyMode?: "proxy" | "remote-key"
}) {
  const [
    { amiraHome, listSessions, SessionStore },
    { parseCliArgs },
    { resolveConfig },
    { createWorkspaceRuntime },
    { planPackages },
  ] = await Promise.all([
    import("@amira/core"),
    import("./args.ts"),
    import("./config.ts"),
    import("./server/runtime.ts"),
    import("./trust.ts"),
  ])
  const home = amiraHome()
  const args = parseCliArgs(["--cwd", options.cwd])
  const readConfig = () => {
    const config = resolveConfig(args, home, process.platform, {
      credentials: options.keyMode === "remote-key" && !options.ai && !options.route ? "load" : "omit",
    })
    const { tui: _localPresentation, ...settings } = config.settings
    return { ...config, settings }
  }
  const config = readConfig()
  const { settings } = config
  const route =
    options.route ?? (options.ai ? undefined : configuredServerAi(config, options.keyMode ?? "proxy"))
  const ai = options.ai ?? route!.ai
  const modelProxy = route?.mode === "proxy" ? route.ai : undefined
  modelProxy?.setReconnectTimeout(resolveRemoteSettings(settings).proxyReconnectTimeoutMs)
  const plan = await planPackages({ cwd: options.cwd, home, settings })
  // Restart restores saved conversation history, never jobs, dialogs or an interrupted turn.
  const latest = listSessions(options.cwd)[0]
  return createWorkspaceRuntime({
    cwd: options.cwd,
    ai,
    modelProxy,
    model: settings.model,
    settings,
    settingsLayers: config.settingsLayers,
    reloadSettings: () => {
      const reloaded = readConfig()
      modelProxy?.setReconnectTimeout(resolveRemoteSettings(reloaded.settings).proxyReconnectTimeoutMs)
      return { settings: reloaded.settings, layers: reloaded.settingsLayers, warnings: reloaded.warnings }
    },
    permissions: config.permissions,
    shell: config.shell,
    disabledTools: config.disabledTools,
    requestedDisabled: config.requestedDisabled,
    warnings: config.warnings,
    packages: plan.packages,
    store: latest ? SessionStore.open(latest.file) : SessionStore.create({ cwd: options.cwd }),
  })
}

/** Probes never read settings, create a session or start a daemon. */
export async function serverMain(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${version}\n`)
    return 0
  }
  if (args.length === 1 && args[0] === "--version-json") {
    const { serverRelease } = await import("./server/identity.ts")
    process.stdout.write(`${JSON.stringify(serverVersionIdentity(serverRelease))}\n`)
    return 0
  }
  if (args.length === 1 && args[0] === "--self-check") {
    process.stdout.write(`${JSON.stringify({ ok: true, runtime: "workspace", daemon: false })}\n`)
    return 0
  }
  try {
    const { runServerCommand } = await import("./server/entry.ts")
    return await runServerCommand(args)
  } catch {
    process.stderr.write("amira-server: unable to start or attach the remote workspace\n")
    return 1
  }
}

if (import.meta.main) process.exitCode = await serverMain(process.argv.slice(2))
