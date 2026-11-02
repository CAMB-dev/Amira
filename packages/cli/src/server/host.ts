import { type DaemonLayout, posixDaemonLayout } from "./layout.ts"
import { type DaemonPlatform, LinuxDaemonPlatform } from "./platform.ts"
import { windowsDaemonLayout } from "./win32-layout.ts"
import { WindowsDaemonPlatform } from "./win32-platform.ts"

export interface DaemonHost {
  platform: DaemonPlatform
  /** Resolved on use: a command that never reaches discovery never needs the OS principal. */
  layout(): DaemonLayout
}

/** The one place that knows which OS effects and private locations a daemon host uses. */
export function selectDaemonHost(
  os: NodeJS.Platform,
  launch: { command: readonly string[]; modelMode: "local-proxy" | "remote-key" },
): DaemonHost {
  if (os === "win32") {
    // Token, integrity and known-folder facts are read once, on first use.
    let layout: DaemonLayout | undefined
    const resolve = () => (layout ??= windowsDaemonLayout())
    return { platform: new WindowsDaemonPlatform(launch.command, launch.modelMode, resolve), layout: resolve }
  }
  if (os !== "linux") throw new Error("Daemons require Linux or Windows")
  return {
    platform: new LinuxDaemonPlatform(launch.command, launch.modelMode),
    // The stable fence is anchored at /tmp, never HOME, TMPDIR, XDG or an Amira config directory.
    layout: () =>
      posixDaemonLayout({
        runtimeDir: process.env.XDG_RUNTIME_DIR,
        tmpDir: "/tmp",
        principal: String(process.getuid!()),
      }),
  }
}
