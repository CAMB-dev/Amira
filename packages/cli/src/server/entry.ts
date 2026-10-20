import path from "node:path"
import { amiraHome, resolveRemoteSettings } from "@amira/core"
import { parseCliArgs } from "../args.ts"
import { resolveConfig } from "../config.ts"
import type { RemoteIO } from "../remote/connection.ts"
import { createServerRuntime } from "../server-main.ts"
import { attachWorkspace, stopWorkspace } from "./attach.ts"
import { startWorkspaceDaemon } from "./daemon.ts"
import { capDaemonOutput } from "./daemon-log.ts"
import { DaemonDiscovery } from "./discovery.ts"
import { serverRelease } from "./identity.ts"
import { LinuxDaemonPlatform } from "./platform.ts"

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

export async function runServerCommand(args: string[]): Promise<number> {
  const interpreter = /^bun(?:\.exe)?$/i.test(path.basename(process.execPath))
  const platform = new LinuxDaemonPlatform(interpreter ? [process.execPath, Bun.main] : [process.execPath])
  const discover = (cwd: string) =>
    new DaemonDiscovery(cwd, {
      runtimeDir: process.env.XDG_RUNTIME_DIR,
      tmpDir: "/tmp",
      uid: process.getuid!(),
    })
  if (args.length === 1 && args[0] === "attach") {
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
      "Usage: amira-server attach | daemon --cwd <workspace> [--remote-key] | stop --cwd <workspace>",
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
  try {
    await daemon.closed
  } finally {
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  }
  return process.exitCode ? 1 : 0
}
