import { amiraHome, resolveRemoteSettings } from "@amira/core"
import { parseCliArgs } from "../args.ts"
import { resolveConfig } from "../config.ts"
import type { RemoteIO } from "../remote/connection.ts"
import { createServerRuntime } from "../server-main.ts"
import { attachWorkspace, stopWorkspace } from "./attach.ts"
import { startWorkspaceDaemon } from "./daemon.ts"
import { capDaemonOutput } from "./daemon-log.ts"
import {
  DaemonDiscovery,
  type DaemonMetadata,
  type DiscoveryOptions,
  listDaemonWorkspaces,
} from "./discovery.ts"
import { DaemonUnavailableError } from "./fallback.ts"
import { hasDaemonHost, selectDaemonHost } from "./host.ts"
import { serverRelease } from "./identity.ts"
import { daemonCommand, type ServerLaunch } from "./launch.ts"
import type { DaemonPlatform } from "./platform.ts"

function stdio(): RemoteIO {
  process.stdout.on("error", () => process.stdin.destroy())
  return {
    input: process.stdin,
    write: (bytes) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))
      }),
    close: () => process.stdin.destroy(),
  }
}

/** The `amira-server list` line (ServerListOutput in the published schema) for live daemons only. */
export function listCommandOutput(
  locations: DiscoveryOptions,
  platform: Pick<DaemonPlatform, "processIdentity">,
): string {
  // Public facts only: never the socket nonce, lock identity or process identity.
  const live = (meta: DaemonMetadata) => {
    try {
      return platform.processIdentity(meta.pid) === meta.processIdentity
    } catch {
      return false
    }
  }
  const workspaces = listDaemonWorkspaces(locations)
    .filter(live)
    .map(({ workspace, protocol, release, daemonEpoch }) => ({ workspace, protocol, release, daemonEpoch }))
  return `${JSON.stringify({ v: 1, workspaces })}\n`
}

export async function runServerCommand(
  args: string[],
  launch: ServerLaunch = { script: Bun.main, subcommand: [] },
): Promise<number> {
  const listing = args.length === 1 && args[0] === "list"
  const none = () => {
    process.stdout.write(`${JSON.stringify({ v: 1, workspaces: [] })}\n`)
    return 0
  }
  // No daemon can run here, so there is none to list.
  if (listing && !hasDaemonHost(process.platform)) return none()
  const host = selectDaemonHost(process.platform, {
    command: daemonCommand(process.execPath, launch),
    modelMode: args.at(-1) === "--remote-key" ? "remote-key" : "local-proxy",
  })
  const { platform } = host
  const discover = (cwd: string) => new DaemonDiscovery(cwd, host.layout())
  if (listing) {
    try {
      process.stdout.write(listCommandOutput(host.layout(), platform))
    } catch (error) {
      // This session may not run daemons (an elevated token, say), so none of its own can exist.
      if (error instanceof DaemonUnavailableError) return none()
      throw error
    }
    return 0
  }
  if (args[0] === "attach" && (args.length === 1 || (args.length === 2 && args[1] === "--remote-key"))) {
    await attachWorkspace({ io: stdio(), discovery: discover, platform, release: serverRelease })
    return 0
  }
  if (
    (args[0] !== "daemon" && args[0] !== "stop") ||
    args[1] !== "--cwd" ||
    !args[2] ||
    (args.length !== 3 && !(args.length === 4 && args[0] === "daemon" && args[3] === "--remote-key"))
  )
    throw new Error(
      "Usage: amira-server attach [--remote-key] | list | daemon --cwd <workspace> [--remote-key] | stop --cwd <workspace>",
    )
  const discovery = discover(args[2])
  if (args[0] === "stop") {
    await stopWorkspace(discovery, platform)
    return 0
  }
  capDaemonOutput()
  const config = resolveConfig(parseCliArgs(["--cwd", discovery.workspace]), amiraHome(), process.platform, {
    credentials: "omit",
  })
  const daemon = await startWorkspaceDaemon({
    discovery,
    platform,
    release: serverRelease,
    idleTimeoutMs: resolveRemoteSettings(config.settings).idleTimeoutMs,
    createRuntime: (cwd) =>
      createServerRuntime({ cwd, keyMode: args[3] === "--remote-key" ? "remote-key" : "proxy" }),
  })
  const stop = () => {
    void daemon.stop().catch(() => {
      process.exitCode = 1
    })
  }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  // Windows: Ctrl+Break and console close. `process.kill(pid)` from another process is
  // TerminateProcess, which runs no handler; lease recovery covers that.
  if (process.platform === "win32") process.once("SIGBREAK", stop)
  try {
    await daemon.closed
  } finally {
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGBREAK", stop)
  }
  return process.exitCode ? 1 : 0
}
