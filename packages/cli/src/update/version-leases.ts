import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { withRetentionGate } from "./retention-gate.ts"
import { parseVersion } from "./semver.ts"

export interface VersionLeaseOptions {
  host?: string
  pid?: number
  /** Unknown (including permission failures) must retain the version. */
  liveness?: (pid: number) => "alive" | "dead" | "unknown"
  /** Revalidate executable identity while holding the same lock as every pruner. */
  validate?: () => Promise<void>
}

export interface VersionLease {
  version: string
  release(): Promise<void>
}

// Shared with install.sh/install.ps1. A lease lives at leases/<version>/<unique>.lease
// and contains exactly this header, lowercase hostname, PID and version, one per line.
export const VERSION_LEASE_HEADER = "amira-version-lease-v1"

export function processLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"
  }
}

async function ordinaryDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid version lease directory")
}

export async function createVersionLease(
  root: string,
  version: string,
  options: VersionLeaseOptions = {},
): Promise<VersionLease> {
  if (!parseVersion(version)) throw new Error("Invalid leased version")
  const host = (options.host ?? hostname()).toLowerCase()
  const pid = options.pid ?? process.pid
  if (!host || /[\r\n]/.test(host) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid version lease owner")
  // Publication and pruning share a short gate, independent of long-running downloads.
  return withRetentionGate(root, async () => {
    await ordinaryDirectory(path.join(root, "versions"))
    await ordinaryDirectory(path.join(root, "versions", version))
    await options.validate?.()
    const leases = path.join(root, "leases")
    await mkdir(leases, { recursive: true })
    await ordinaryDirectory(leases)
    const directory = path.join(leases, version)
    await mkdir(directory, { recursive: true })
    await ordinaryDirectory(directory)
    const file = path.join(directory, `${pid}.${randomUUID()}.lease`)
    const content = `${VERSION_LEASE_HEADER}\n${host}\n${pid}\n${version}\n`
    await writeFile(file, content, { flag: "wx", mode: 0o600 })
    return {
      version,
      async release() {
        // Do not remove an unexpected replacement, even though the name is unguessable.
        const info = await lstat(file).catch(() => undefined)
        if (
          info?.isFile() &&
          !info.isSymbolicLink() &&
          (await readFile(file, "utf8").catch(() => undefined)) === content
        )
          await rm(file, { force: true })
      },
    }
  })
}

/** Undefined means the lease layout cannot be trusted: skip all version pruning. */
export async function liveVersionLeases(
  root: string,
  options: VersionLeaseOptions = {},
): Promise<Set<string> | undefined> {
  const leases = path.join(root, "leases")
  const info = await lstat(leases).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (!info) return new Set()
  if (!info.isDirectory() || info.isSymbolicLink()) return undefined
  const host = (options.host ?? hostname()).toLowerCase()
  const liveness = options.liveness ?? processLiveness
  const held = new Set<string>()
  for (const directory of await readdir(leases, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink() || !parseVersion(directory.name))
      return undefined
    for (const entry of await readdir(path.join(leases, directory.name), { withFileTypes: true })) {
      const file = path.join(leases, directory.name, entry.name)
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".lease")) {
        held.add(directory.name)
        continue
      }
      const content = await readFile(file, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        return ""
      })
      if (content === undefined) continue // A normal release raced this read.
      const lines = content.split("\n")
      const pid = Number(lines[2])
      if (
        lines.length !== 5 ||
        lines[0] !== VERSION_LEASE_HEADER ||
        lines[1] !== host ||
        !/^[1-9]\d*$/.test(lines[2] ?? "") ||
        !Number.isSafeInteger(pid) ||
        lines[3] !== directory.name ||
        lines[4] !== ""
      ) {
        held.add(directory.name)
        continue
      }
      let state: "alive" | "dead" | "unknown" = "unknown"
      try {
        state = liveness(pid)
      } catch {}
      if (state !== "dead") held.add(directory.name)
      else
        await rm(file, { force: true }).catch(() => {
          held.add(directory.name)
        })
    }
  }
  return held
}
