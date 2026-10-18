import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { installSource, upgradeCommand } from "../install-source.ts"
import { isUpdateTarget, type UpdateChannel } from "./manifest.ts"
import { isReleaseVersion, parseVersion } from "./semver.ts"

export interface InstallRecord {
  kind: "single-file"
  version: string
  channel: UpdateChannel
  target: string
  bin: string
  previousVersion?: string
}

export interface InstallOptions {
  version: string
  target: string
  executable?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  installRoot?: string
  bin?: string
}

export function installPaths(options: InstallOptions) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const root =
    options.installRoot ??
    (platform === "win32"
      ? path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Amira")
      : path.join(home, ".local", "share", "amira"))
  const executableName = platform === "win32" ? "amira.exe" : "amira"
  const bin =
    options.bin ??
    (platform === "win32"
      ? path.join(root, "bin", executableName)
      : path.join(home, ".local", "bin", executableName))
  return { root: path.resolve(root), bin: path.resolve(bin), executableName, platform }
}

function samePath(a: string, b: string, platform: NodeJS.Platform) {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

export async function readInstall(options: InstallOptions): Promise<InstallRecord> {
  const paths = installPaths(options)
  const value: unknown = JSON.parse(await readFile(path.join(paths.root, "install.json"), "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid self-managed install marker")
  const marker = value as Record<string, unknown>
  if (
    marker.kind !== "single-file" ||
    typeof marker.version !== "string" ||
    !parseVersion(marker.version) ||
    (marker.channel !== "stable" && marker.channel !== "next") ||
    !isUpdateTarget(marker.target) ||
    marker.target !== options.target ||
    typeof marker.bin !== "string" ||
    !samePath(path.resolve(marker.bin), paths.bin, paths.platform) ||
    (marker.previousVersion !== undefined &&
      (typeof marker.previousVersion !== "string" || !parseVersion(marker.previousVersion)))
  )
    throw new Error("Invalid self-managed install marker")
  const canonicalRoot = await realpath(paths.root)
  if (
    !samePath(
      await realpath(path.join(paths.root, "versions")),
      path.join(canonicalRoot, "versions"),
      paths.platform,
    )
  )
    throw new Error("Versions directory is outside the self-managed install layout")
  const canonicalExecutable = await realpath(options.executable ?? process.execPath)
  const relative = path.relative(canonicalRoot, canonicalExecutable).split(path.sep)
  const inBin =
    relative.length === 2 &&
    relative[0] === "bin" &&
    relative[1] === paths.executableName &&
    paths.platform === "win32"
  const inVersion =
    relative.length === 3 &&
    relative[0] === "versions" &&
    !!parseVersion(relative[1]!) &&
    relative[2] === paths.executableName
  if (!inBin && !inVersion) throw new Error("The executable is outside the self-managed install layout")
  return {
    kind: "single-file",
    version: marker.version,
    channel: marker.channel,
    target: marker.target,
    bin: paths.bin,
    ...(typeof marker.previousVersion === "string" ? { previousVersion: marker.previousVersion } : {}),
  }
}

/** Never infer ownership solely from an executable named amira or its release build metadata. */
export async function installDisabledReason(options: InstallOptions): Promise<string | undefined> {
  const source = installSource(options.executable ?? process.execPath)
  const command = upgradeCommand(source)
  if (command) return `This installation is managed by ${source}. Upgrade with: ${command}`
  if (source === "dev" || !isReleaseVersion(options.version))
    return "Development, source and 0.0.0 builds do not self-update."
  try {
    await readInstall(options)
  } catch {
    return "This is not a self-managed single-file installation. Reinstall with the official install script to enable updates."
  }
  return undefined
}
