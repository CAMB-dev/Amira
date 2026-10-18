import { randomUUID } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { InstallRecord } from "./install.ts"
import { withRetentionGate } from "./retention-gate.ts"
import { compareVersions, parseVersion } from "./semver.ts"
import { liveVersionLeases, type VersionLeaseOptions } from "./version-leases.ts"

export interface SwapFiles {
  rename: typeof rename
  copyFile: typeof copyFile
  rm: typeof rm
  symlink: typeof symlink
}

let lastSwapTimestamp = 0

/** A live Windows image may be renamed, but cannot be overwritten or deleted. */
export async function swapExecutable(
  source: string,
  bin: string,
  platform: NodeJS.Platform,
  files: SwapFiles = { rename, copyFile, rm, symlink },
): Promise<void> {
  await mkdir(path.dirname(bin), { recursive: true })
  const timestamp = Math.max(Date.now(), lastSwapTimestamp + 1)
  lastSwapTimestamp = timestamp
  const temporary = `${bin}.new.${timestamp}.${process.pid}`
  if (platform !== "win32") {
    try {
      await files.symlink(source, temporary)
      await files.rename(temporary, bin)
    } finally {
      await files.rm(temporary, { force: true }).catch(() => {})
    }
    return
  }
  const old = `${bin}.old.${timestamp}.${process.pid}`
  let moved = false
  try {
    await files.rename(bin, old)
    moved = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    await files.copyFile(source, bin)
  } catch (error) {
    await files.rm(bin, { force: true }).catch(() => {})
    if (moved) {
      try {
        await files.rename(old, bin)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Update failed; could not restore ${bin}. The previous executable is at ${old}.`,
        )
      }
    }
    throw error
  }
}

export async function writeInstall(root: string, record: InstallRecord): Promise<void> {
  const temporary = path.join(root, `install.json.new.${process.pid}.${randomUUID()}`)
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await rename(temporary, path.join(root, "install.json"))
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function keptVersions(root: string): Promise<string[]> {
  const versions = path.join(root, "versions")
  const entries = await readdir(versions, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  return entries
    .filter((entry) => entry.isDirectory() && parseVersion(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b, a))
}

export async function cleanupInstall(
  root: string,
  bin: string,
  record: InstallRecord,
  runningVersions: readonly string[] = [],
  leaseOptions: VersionLeaseOptions = {},
): Promise<void> {
  // The caller holds the update lock, so no live updater can own these abandoned staging dirs.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.update-[A-Za-z0-9]{6}$/.test(entry.name)) {
      await rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {})
    }
  }
  for (const entry of await readdir(path.dirname(bin)).catch(() => [])) {
    const prefix = `${path.basename(bin)}.old.`
    if (entry.startsWith(prefix) && /^\d+\.\d+$/.test(entry.slice(prefix.length))) {
      await rm(path.join(path.dirname(bin), entry), { force: true }).catch(() => {})
    }
  }
  await withRetentionGate(root, async () => {
    const held = await liveVersionLeases(root, leaseOptions).catch(() => undefined)
    if (!held) return // Unknown lease state is not permission to delete an in-use executable.
    const versions = await keptVersions(root)
    const keep = new Set([record.version, ...(record.previousVersion ? [record.previousVersion] : [])])
    for (const version of versions) if (keep.size < 3) keep.add(version)
    // Live versions are additional to the normal three-version rollback window.
    for (const version of [...runningVersions, ...held]) keep.add(version)
    for (const version of versions)
      if (!keep.has(version))
        await rm(path.join(root, "versions", version), { recursive: true, force: true }).catch(() => {})
  }).catch(() => {}) // Brief contention or unknown gate state only defers pruning.
}

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: 15_000 })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Release command failed: ${stderr.trim() || argv[0]}`)
  return stdout.trim()
}

export async function extractExecutable(archive: string, directory: string, name: string): Promise<void> {
  // Never let a signed-but-malformed archive write paths outside the private staging directory.
  // Git's GNU tar may precede Windows' bsdtar on PATH and cannot read release ZIPs.
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar"
  const entries = (await run([tar, "-tf", archive])).split(/\r?\n/)
  if (entries.length !== 1 || (entries[0] !== name && entries[0] !== `./${name}`))
    throw new Error("Release archive must contain only the executable")
  await run([tar, "-xf", archive, "-C", directory, entries[0]!])
  const file = path.join(directory, name)
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Release executable must be a regular file")
  await chmod(file, 0o755)
}

export async function probeExecutable(file: string): Promise<string> {
  return (await run([file, "--version"])).split(/\s+/)[0] ?? ""
}

export async function assertExecutable(file: string): Promise<void> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Installed executable must be a regular file")
  if (!stat.size) throw new Error("Installed executable is empty")
}
