import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tryFileLock } from "@amira/core"
import { installSource } from "../install-source.ts"
import { channel as buildChannel, target as buildTarget, version as buildVersion } from "../version.ts"
import {
  assertExecutable,
  cleanupInstall,
  extractExecutable,
  keptVersions,
  probeExecutable,
  swapExecutable,
  writeInstall,
} from "./files.ts"
import {
  type InstallOptions,
  type InstallRecord,
  installDisabledReason,
  installPaths,
  readInstall,
} from "./install.ts"
import {
  downloadBytes,
  manifestUrl,
  type ReleaseManifest,
  releaseBase,
  type UpdateChannel,
  verifyReleaseManifest,
} from "./manifest.ts"
import { releasePublicKey } from "./public-key.ts"
import { withRetentionGate } from "./retention-gate.ts"
import { compareVersions, isReleaseVersion, parseVersion } from "./semver.ts"
import { createVersionLease, type VersionLease } from "./version-leases.ts"

export type { UpdateChannel } from "./manifest.ts"

export interface UpdaterOptions extends Partial<InstallOptions> {
  channel?: UpdateChannel
  publicKey?: string
  fetch?: typeof fetch
  /** URL overrides and process/file seams are internal test hooks, never read from the environment. */
  manifestUrl?: (channel: UpdateChannel) => string
  artifactUrl?: (manifest: ReleaseManifest, file: string) => string
  extract?: typeof extractExecutable
  probe?: typeof probeExecutable
  swap?: typeof swapExecutable
}

function switched(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false"
}

export function createUpdater(options: UpdaterOptions = {}) {
  const config: InstallOptions = {
    ...options,
    version: options.version ?? buildVersion,
    target: options.target ?? buildTarget,
  }
  const paths = installPaths(config)
  const pem = options.publicKey ?? releasePublicKey
  const fetcher = options.fetch ?? fetch
  const selectedChannel = options.channel ?? (buildChannel === "next" ? "next" : "stable")
  const env = options.env ?? process.env
  const probe = options.probe ?? probeExecutable
  const swap = options.swap ?? swapExecutable
  // Install the exact signed release the caller evaluated (patch/minimum-version policy).
  // A moving channel must not silently change a patch check into a minor/major installation.
  const checkedReleases = new Map<UpdateChannel, ReleaseManifest>()
  const networkAbort = new AbortController()
  let stopping = false
  let activation: Promise<void> | undefined
  let pinning: Promise<void> | undefined
  let lease: VersionLease | undefined
  let runningVersion: string | undefined

  /** Session lifetime ownership is independent of update settings, networking and signing keys. */
  function pinVersion(): Promise<void> {
    if (pinning) return pinning
    const pending = (async () => {
      const image = config.executable ?? process.execPath
      if (stopping || installSource(image) !== "releases" || !isReleaseVersion(config.version)) return
      const root = await realpath(paths.root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (!root) return
      const absolute = path.resolve(image)
      const executable = await realpath(image).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute
        throw error
      })
      const relative = path.relative(root, executable).split(path.sep)
      const lexical = path.relative(paths.root, absolute).split(path.sep)
      const versionAt = (parts: string[]) =>
        parts.length === 3 &&
        parts[0] === "versions" &&
        parseVersion(parts[1] ?? "") &&
        parts[2] === paths.executableName
          ? parts[1]
          : undefined
      const loadedVersion = versionAt(relative) ?? versionAt(lexical)
      const inBin =
        paths.platform === "win32"
          ? absolute.toLowerCase() === paths.bin.toLowerCase() ||
            (relative.length === 2 && relative[0] === "bin" && relative[1] === paths.executableName)
          : absolute === paths.bin
      if (!loadedVersion && !inBin) return
      const marker = await lstat(path.join(paths.root, "install.json")).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (!marker) return
      // Preserve the loaded image's identity even if another process replaced the bin copy.
      // A deleted managed image must fail lease validation, not become an unmanaged no-op.
      runningVersion = loadedVersion ?? config.version
      lease = await createVersionLease(paths.root, runningVersion, {
        validate: async () => {
          await readInstall(config)
          await assertExecutable(path.join(paths.root, "versions", runningVersion!, paths.executableName))
        },
      })
    })()
    pinning = pending
    void pending.catch(() => {
      if (pinning === pending) pinning = undefined
    })
    return pending
  }

  async function stop(): Promise<void> {
    stopping = true
    networkAbort.abort()
    // Do not hold shutdown for a download, but never interrupt the rename/copy/restore transaction.
    await activation?.catch(() => {})
    await pinning?.catch(() => {})
    await lease?.release().catch(() => {})
  }

  async function disabledReason(): Promise<string | undefined> {
    if (switched(env.AMIRA_DISABLE_UPDATES)) return "Updates are disabled by AMIRA_DISABLE_UPDATES."
    const reason = await installDisabledReason(config)
    if (reason) return reason
    if (!pem) return "Release updates are disabled: no release public key is configured in this build."
    return undefined
  }

  async function requireInstall(network: boolean): Promise<InstallRecord> {
    if (stopping) throw new Error("The updater is stopping")
    const reason = network
      ? await disabledReason()
      : switched(env.AMIRA_DISABLE_UPDATES)
        ? "Updates are disabled by AMIRA_DISABLE_UPDATES."
        : await installDisabledReason(config)
    if (reason) throw new Error(reason)
    if (network && switched(env.AMIRA_OFFLINE))
      throw new Error("Update downloads are disabled by AMIRA_OFFLINE.")
    const record = await readInstall(config)
    await pinVersion()
    if (stopping) throw new Error("The updater is stopping")
    return record
  }

  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = tryFileLock(path.join(paths.root, "update.lock"), 10 * 60_000, 30_000, true)
    if (!lock) throw new Error("Another Amira update is already in progress.")
    try {
      return await work()
    } finally {
      lock.release()
    }
  }

  async function manifest(channel: UpdateChannel): Promise<ReleaseManifest> {
    const url = (options.manifestUrl ?? manifestUrl)(channel)
    const [bytes, signature] = await Promise.all([
      downloadBytes(url, 1024 * 1024, fetcher, networkAbort.signal),
      downloadBytes(`${url}.sig`, 1024, fetcher, networkAbort.signal),
    ])
    const result = verifyReleaseManifest(bytes, Buffer.from(signature).toString("utf8"), pem)
    if (result.channel !== channel)
      throw new Error("Release manifest channel does not match the requested channel")
    if (!result.artifacts.some((artifact) => artifact.target === config.target))
      throw new Error("No release artifact matches this build target")
    return result
  }

  async function check(channel: UpdateChannel = selectedChannel) {
    await requireInstall(true)
    return locked(async () => {
      const release = await manifest(channel)
      checkedReleases.set(channel, release)
      return { version: release.version, channel: release.channel }
    })
  }

  async function activate(record: InstallRecord, next: InstallRecord): Promise<void> {
    const source = path.join(paths.root, "versions", next.version, paths.executableName)
    const expected = path.join(await realpath(paths.root), "versions", next.version, paths.executableName)
    const actual = await realpath(source)
    if (paths.platform === "win32" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)
      throw new Error("Version executable is outside the self-managed install layout")
    await assertExecutable(source)
    if ((await probe(source)) !== next.version)
      throw new Error("Release executable version does not match the manifest")
    await swap(source, paths.bin, paths.platform)
    try {
      await writeInstall(paths.root, next)
    } catch (error) {
      const previous = path.join(paths.root, "versions", record.version, paths.executableName)
      try {
        await swap(previous, paths.bin, paths.platform)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Could not save the install marker or restore the previous executable",
        )
      }
      throw error
    }
  }

  async function update(channel: UpdateChannel = selectedChannel): Promise<string> {
    await requireInstall(true)
    return locked(async () => {
      const record = await readInstall(config)
      const release = checkedReleases.get(channel) ?? (await manifest(channel))
      checkedReleases.delete(channel)
      // A second session may already have installed the release while this process kept running.
      if (compareVersions(release.version, record.version) <= 0) return record.version
      const artifact = release.artifacts.find((entry) => entry.target === config.target)!
      const staging = await mkdtemp(path.join(paths.root, ".update-"))
      try {
        const bytes = await downloadBytes(
          (options.artifactUrl ?? ((m, file) => `${releaseBase}/download/v${m.version}/${file}`))(
            release,
            artifact.file,
          ),
          artifact.size,
          fetcher,
          networkAbort.signal,
        )
        if (
          bytes.length !== artifact.size ||
          createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
        )
          throw new Error("Release archive SHA-256 or size mismatch")
        const archive = path.join(staging, artifact.file)
        await writeFile(archive, bytes, { flag: "wx" })
        const extracted = path.join(staging, "extracted")
        await mkdir(extracted)
        await (options.extract ?? extractExecutable)(archive, extracted, paths.executableName)
        const executable = path.join(extracted, paths.executableName)
        await assertExecutable(executable)
        if ((await probe(executable)) !== release.version)
          throw new Error("Release executable version does not match the manifest")
        if (stopping) throw new Error("The updater is stopping")
        activation = withRetentionGate(paths.root, async () => {
          if (stopping) throw new Error("The updater is stopping")
          const destination = path.join(paths.root, "versions", release.version)
          await mkdir(path.dirname(destination), { recursive: true })
          // Reuse authenticated bytes left by an interrupted transaction, never overwrite a
          // directory which another running process may still use.
          const existing = await lstat(destination).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
            throw error
          })
          if (existing) {
            if (!existing.isDirectory() || existing.isSymbolicLink())
              throw new Error("Existing version is not a regular directory")
            const saved = path.join(destination, paths.executableName)
            await assertExecutable(saved)
            if (!(await readFile(saved)).equals(await readFile(executable)))
              throw new Error(`Version ${release.version} differs; refusing to overwrite it`)
          } else await rename(extracted, destination)
          try {
            await activate(record, {
              ...record,
              version: release.version,
              channel,
              previousVersion: record.version,
            })
          } catch (error) {
            // Keep recovery evidence when restoration failed and executable state is uncertain.
            if (!existing && !(error instanceof AggregateError))
              await rm(destination, { recursive: true, force: true }).catch(() => {})
            throw error
          }
        })
        try {
          await activation
        } finally {
          activation = undefined
        }
        await cleanupInstall(
          paths.root,
          paths.bin,
          {
            ...record,
            version: release.version,
            previousVersion: record.version,
          },
          runningVersion ? [runningVersion] : [],
        )
        return release.version
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  async function rollback(minimumVersion?: string): Promise<string> {
    await requireInstall(false)
    return locked(async () => {
      const record = await readInstall(config)
      const versions = await keptVersions(paths.root)
      const previous =
        record.previousVersion ?? versions.find((version) => compareVersions(version, record.version) < 0)
      if (!previous || previous === record.version || !versions.includes(previous))
        throw new Error("No previous Amira version is available for rollback")
      if (minimumVersion !== undefined && compareVersions(previous, minimumVersion) < 0)
        throw new Error(`Rollback version ${previous} is below updates.minimumVersion (${minimumVersion})`)
      if (stopping) throw new Error("The updater is stopping")
      activation = withRetentionGate(paths.root, async () => {
        if (stopping) throw new Error("The updater is stopping")
        await activate(record, { ...record, version: previous, previousVersion: record.version })
      })
      try {
        await activation
      } finally {
        activation = undefined
      }
      await cleanupInstall(
        paths.root,
        paths.bin,
        { ...record, version: previous, previousVersion: record.version },
        runningVersion ? [runningVersion] : [],
      )
      return previous
    })
  }

  async function cleanup(): Promise<void> {
    await requireInstall(false)
    await locked(async () =>
      cleanupInstall(
        paths.root,
        paths.bin,
        await readInstall(config),
        runningVersion ? [runningVersion] : [],
      ),
    )
  }

  return { disabledReason, check, update, rollback, cleanup, stop, pinVersion }
}
