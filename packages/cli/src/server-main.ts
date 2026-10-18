import type { Ai } from "@amira/ai"
import { version } from "./version.ts"

/** Host launch seam: AI routing is explicit; proxy/remote-key selection arrives in B08. */
export async function createServerRuntime(options: { cwd: string; ai: Ai }) {
  const [
    { amiraHome, SessionStore },
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
    const config = resolveConfig(args, home, process.platform, { credentials: "omit" })
    const { tui: _localPresentation, ...settings } = config.settings
    return { ...config, settings }
  }
  const config = readConfig()
  const { settings } = config
  const plan = await planPackages({ cwd: options.cwd, home, settings })
  return createWorkspaceRuntime({
    cwd: options.cwd,
    ai: options.ai,
    model: settings.model,
    settings,
    settingsLayers: config.settingsLayers,
    reloadSettings: () => {
      const reloaded = readConfig()
      return { settings: reloaded.settings, layers: reloaded.settingsLayers, warnings: reloaded.warnings }
    },
    permissions: config.permissions,
    shell: config.shell,
    disabledTools: config.disabledTools,
    requestedDisabled: config.requestedDisabled,
    warnings: config.warnings,
    packages: plan.packages,
    store: SessionStore.create({ cwd: options.cwd }),
  })
}

/** Settings-free executable probes only until the daemon/relay launcher is implemented. */
export async function serverMain(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${version}\n`)
    return 0
  }
  if (args.length === 1 && args[0] === "--self-check") {
    process.stdout.write(`${JSON.stringify({ ok: true, runtime: "workspace", daemon: false })}\n`)
    return 0
  }
  process.stderr.write("amira-server: daemon/attach launching is not implemented yet\n")
  return 1
}

if (import.meta.main) process.exitCode = await serverMain(process.argv.slice(2))
