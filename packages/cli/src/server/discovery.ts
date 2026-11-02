import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { type FileLock, tryFileLock } from "../../../core/src/file-lock.ts"
import { strictOwnerState } from "../../../core/src/file-lock-owner.ts"
import { REMOTE_PROTOCOL_VERSION, type RemoteRelease } from "../remote/protocol.ts"
import { type DaemonLayout, type PosixLayoutOptions, posixDaemonLayout } from "./layout.ts"
import { type DaemonEndpoint, type SocketChecks, socketEndpoint } from "./socket-endpoint.ts"

export interface DaemonMetadata {
  workspace: string
  socket: string
  protocol: number
  release: RemoteRelease
  daemonEpoch: string
  pid: number
  processIdentity: string
  nonce: string
  lockIdentity: string
}
/** A host layout, or the POSIX layout's inputs (tests inject permission models through these). */
export type DiscoveryOptions = DaemonLayout | PosixLayoutOptions

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const layoutOf = (options: DiscoveryOptions): DaemonLayout =>
  "stableRoot" in options ? options : posixDaemonLayout(options)
const token = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9:._-]{1,256}$/.test(value)
const label = (value: unknown) => typeof value === "string" && value.length > 0 && value.length < 256

/** Required keys must be present and valid. Unknown keys are ignored and never returned. */
function parseMetadata(value: unknown): DaemonMetadata | undefined {
  if (!value || typeof value !== "object") return undefined
  const meta = value as Partial<DaemonMetadata>
  const release = meta.release as Partial<RemoteRelease> | undefined
  if (
    typeof meta.workspace !== "string" ||
    typeof meta.socket !== "string" ||
    !Number.isSafeInteger(meta.protocol) ||
    !Number.isSafeInteger(meta.pid) ||
    meta.pid! < 1 ||
    ![meta.daemonEpoch, meta.processIdentity, meta.nonce, meta.lockIdentity].every(token) ||
    !release ||
    typeof release !== "object" ||
    ![release.version, release.buildId, release.target].every(label)
  )
    return undefined
  return {
    workspace: meta.workspace,
    socket: meta.socket,
    protocol: meta.protocol!,
    release: { version: release.version!, buildId: release.buildId!, target: release.target! },
    daemonEpoch: meta.daemonEpoch!,
    pid: meta.pid!,
    processIdentity: meta.processIdentity!,
    nonce: meta.nonce!,
    lockIdentity: meta.lockIdentity!,
  }
}

/** Private, version-independent workspace paths. Metadata never grants lock recovery authority. */
export class DaemonDiscovery {
  readonly workspace: string
  readonly directory: string
  /** Stable fence even when SSH environments disagree about XDG_RUNTIME_DIR. */
  readonly ownershipDirectory: string
  readonly socket: string
  readonly metadataFile: string
  private owner?: FileLock
  private ownerIdentity?: string
  private check: (file: string, directory: boolean) => void
  private socketChecks: SocketChecks
  private layout: DaemonLayout
  private key: string

  constructor(cwd: string, options: DiscoveryOptions) {
    const layout = layoutOf(options)
    this.layout = layout
    const { workspace, key } = layout.workspaceKey(cwd)
    this.workspace = workspace
    this.key = key
    this.check = layout.checkPrivate
    this.socketChecks = {
      privatePath: this.check,
      socketPath: (file) => {
        this.check(file, false)
        layout.checkEndpoint(file)
      },
      ancestor: layout.checkAncestor,
    }
    const stable = this.privateDirectory(layout.stableRoot)
    this.ownershipDirectory = this.privateDirectory(path.join(stable, key))
    let base: string | undefined
    if (layout.runtimeRoot) {
      try {
        this.check(layout.runtimeRoot, true)
        base = this.privateDirectory(path.join(layout.runtimeRoot, "amira"))
        // Leave room for the workspace and endpoint names.
        const probe = "0".repeat(24)
        if (!layout.validateEndpoint(layout.endpointFor(path.join(base, probe)), probe)) base = undefined
      } catch {
        // A rejected runtime root is never modified. The fallback is the stable root.
      }
    }
    base ??= stable
    this.directory = this.privateDirectory(path.join(base, key))
    this.socket = layout.endpointFor(this.directory)
    if (!layout.validateEndpoint(this.socket, key)) throw new Error("Remote runtime socket path is too long")
    this.metadataFile = path.join(this.ownershipDirectory, "daemon.json")
  }

  private retryBusy<T>(operation: () => T): T {
    return this.layout.retryBusy ? this.layout.retryBusy(operation) : operation()
  }

  private privateDirectory(file: string): string {
    this.layout.makePrivateDirectory(file)
    this.check(file, true)
    return file
  }

  validate(): void {
    this.check(path.dirname(this.ownershipDirectory), true)
    this.check(this.ownershipDirectory, true)
  }

  validateSocketDirectory(): void {
    this.check(path.dirname(this.directory), true)
    this.check(this.directory, true)
  }

  /** Read-only launch hint, never authority to steal a lock or construct a second runtime. */
  canStart(): boolean {
    this.validate()
    const file = path.join(this.ownershipDirectory, "owner.lock")
    try {
      this.check(file, false)
      return strictOwnerState(readFileSync(file, "utf8"), this.layout.leasePolicy) === "dead"
    } catch (error) {
      if (missing(error)) return true
      throw error
    }
  }

  claim(kind: "startup" | "owner"): FileLock | undefined {
    this.validate()
    const file = path.join(this.ownershipDirectory, `${kind}.lock`)
    try {
      this.check(file, false)
    } catch (error) {
      if (!missing(error)) throw error
    }
    // Strict mode requires proven local death, not age, failed connect or a recycled PID.
    const lock = tryFileLock(file, Infinity, undefined, true, undefined, this.layout.leasePolicy)
    if (!lock) return undefined
    chmodSync(file, 0o600)
    if (kind === "startup") return lock
    const held: FileLock = {
      release: () => {
        if (this.owner !== held) return
        this.owner = undefined
        this.ownerIdentity = undefined
        lock.release()
      },
    }
    this.owner = held
    this.ownerIdentity = this.lockIdentity()
    return held
  }

  lockIdentity(): string {
    const file = path.join(this.ownershipDirectory, "owner.lock")
    this.check(file, false)
    return digest(readFileSync(file, "utf8"))
  }

  read(): DaemonMetadata | undefined {
    this.validate()
    let value: unknown
    try {
      this.check(this.metadataFile, false)
      if (lstatSync(this.metadataFile).size > 8192) throw new Error("Oversized daemon metadata")
      value = JSON.parse(this.retryBusy(() => readFileSync(this.metadataFile, "utf8")))
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
    const meta = parseMetadata(value)
    if (!meta || meta.workspace !== this.workspace || !this.layout.validateEndpoint(meta.socket, this.key))
      throw new Error("Invalid daemon metadata")
    if (meta.lockIdentity !== this.lockIdentity()) throw new Error("Daemon owner was replaced")
    return meta
  }

  endpoint(meta: DaemonMetadata): DaemonEndpoint {
    const identity = {
      socket: meta.socket,
      principal: this.layout.principal.key,
      pid: meta.pid,
      processIdentity: meta.processIdentity,
    }
    const verifyOwner = () => {
      this.validate()
      if (meta.workspace !== this.workspace || meta.lockIdentity !== this.lockIdentity())
        throw new Error("Daemon ownership changed before connect")
    }
    if (this.layout.endpointIsFile)
      return socketEndpoint(identity, this.socketChecks, this.ownershipDirectory, verifyOwner)
    // A named endpoint has no path to pin; the platform's connection proof, keyed by the
    // ACL-private nonce, must bind it instead.
    const verify = () => {
      verifyOwner()
      if (!this.layout.validateEndpoint(meta.socket, this.key)) throw new Error("Invalid daemon endpoint")
    }
    verify()
    return Object.freeze({ ...identity, nonce: meta.nonce, verify })
  }

  private assertOwner(): void {
    this.validate()
    if (!this.owner || this.ownerIdentity !== this.lockIdentity()) throw new Error("Daemon ownership changed")
  }

  /** False once the owner lock was replaced or removed under a running daemon. */
  ownsLock(): boolean {
    try {
      this.assertOwner()
      return true
    } catch {
      return false
    }
  }

  /** Keeps age-based temp cleaners away from a long-lived daemon's files. */
  touch(): void {
    this.assertOwner()
    const now = new Date()
    for (const directory of new Set([
      path.dirname(this.ownershipDirectory),
      this.ownershipDirectory,
      this.directory,
    ])) {
      this.check(directory, true)
      utimesSync(directory, now, now)
    }
    for (const file of [path.join(this.ownershipDirectory, "owner.lock"), this.metadataFile]) {
      try {
        this.check(file, false)
        utimesSync(file, now, now)
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
  }

  publish(meta: DaemonMetadata): void {
    this.assertOwner()
    if (meta.lockIdentity !== this.lockIdentity()) throw new Error("Daemon ownership changed")
    const temp = `${this.metadataFile}.${randomUUID()}`
    try {
      writeFileSync(temp, JSON.stringify(meta), { flag: "wx", mode: 0o600 })
      this.retryBusy(() => renameSync(temp, this.metadataFile))
    } finally {
      rmSync(temp, { force: true })
    }
  }

  /** Withdraws readiness first, so no client finds metadata next to a closed endpoint. */
  retireMetadata(): void {
    this.assertOwner()
    this.removeMetadata()
  }

  private removeMetadata(): void {
    try {
      this.check(this.metadataFile, false)
      rmSync(this.metadataFile)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }

  /** Only a held owner lock permits removing stale sockets/metadata, including after a crash. */
  clearOwnedFiles(): void {
    this.assertOwner()
    let socketError: unknown
    if (this.layout.endpointIsFile) {
      try {
        this.validateSocketDirectory()
        this.check(this.socket, false)
        rmSync(this.socket)
      } catch (error) {
        if (!missing(error)) socketError = error
      }
    }
    // XDG may disappear on logout. Still retire owned stable metadata before releasing the fence.
    this.removeMetadata()
    if (socketError) throw socketError
  }

  privateSocket(): void {
    if (!this.layout.endpointIsFile) return
    this.validateSocketDirectory()
    chmodSync(this.socket, 0o600)
    this.check(this.socket, false)
  }

  replacement(release?: RemoteRelease): boolean {
    const file = path.join(this.ownershipDirectory, "replacement.json")
    this.validate()
    if (release) {
      // A relay only requests drain; it cannot stop work or change workspace ownership.
      try {
        this.check(file, false)
      } catch (error) {
        if (!missing(error)) throw error
      }
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        this.check(file, false)
        writeFileSync(fd, JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, release }))
      } finally {
        closeSync(fd)
      }
      return true
    }
    try {
      this.check(file, false)
      return lstatSync(file).size > 0
    } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }

  clearReplacement(): void {
    const file = path.join(this.ownershipDirectory, "replacement.json")
    try {
      this.check(file, false)
      rmSync(file)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

/** Published daemons of this OS user, oldest key first. Callers still prove each process identity. */
export function listDaemonWorkspaces(options: DiscoveryOptions): DaemonMetadata[] {
  const layout = layoutOf(options)
  let keys: string[]
  try {
    keys = readdirSync(layout.stableRoot).filter((key) => /^[a-f0-9]{24}$/.test(key))
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const found: DaemonMetadata[] = []
  for (const key of keys.sort()) {
    try {
      const file = path.join(layout.stableRoot, key, "daemon.json")
      if (lstatSync(file).size > 8192) continue
      const { workspace } = JSON.parse(readFileSync(file, "utf8")) as { workspace?: unknown }
      if (typeof workspace !== "string") continue
      // The workspace's own discovery re-derives the key and applies every ownership/privacy check.
      const discovery = new DaemonDiscovery(workspace, layout)
      const meta = path.basename(discovery.ownershipDirectory) === key ? discovery.read() : undefined
      if (meta) found.push(meta)
    } catch {
      // Unreadable, foreign, stale or moved workspaces are simply not listed.
    }
  }
  return found
}
