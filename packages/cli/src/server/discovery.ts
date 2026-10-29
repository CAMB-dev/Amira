import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { type FileLock, tryFileLock } from "../../../core/src/file-lock.ts"
import { strictOwnerState } from "../../../core/src/file-lock-owner.ts"
import { REMOTE_PROTOCOL_VERSION, type RemoteRelease } from "../remote/protocol.ts"
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
export interface DiscoveryOptions {
  /** Accepted for source compatibility; never participates in workspace ownership. */
  home?: string
  runtimeDir?: string
  tmpDir: string
  uid: number
  /** Windows tests supply a permission model; production always checks Linux ownership/modes. */
  checkPrivate?: (file: string, directory: boolean) => void
  /** Socket/ancestor permission models are injectable only for non-Linux test filesystems. */
  checkSocket?: (file: string) => void
  checkAncestor?: (file: string) => void
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

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
  private uid: number

  constructor(cwd: string, options: DiscoveryOptions) {
    this.workspace = realpathSync(cwd)
    this.uid = options.uid
    this.check =
      options.checkPrivate ??
      ((file, directory) => {
        const stat = lstatSync(file)
        if (
          stat.isSymbolicLink() ||
          (directory ? !stat.isDirectory() : !stat.isFile() && !stat.isSocket()) ||
          stat.uid !== options.uid ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error("Remote runtime path is not private and owned")
      })
    this.socketChecks = {
      privatePath: this.check,
      socketPath: (file) => {
        this.check(file, false)
        if (options.checkSocket) options.checkSocket(file)
        else if (!lstatSync(file).isSocket()) throw new Error("Daemon endpoint is not a private socket")
      },
      ancestor:
        options.checkAncestor ??
        ((file) => {
          const stat = lstatSync(file)
          const trustedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0
          if (
            stat.isSymbolicLink() ||
            !stat.isDirectory() ||
            (stat.uid !== 0 && stat.uid !== this.uid) ||
            ((stat.mode & 0o022) !== 0 && !trustedSticky)
          )
            throw new Error("Daemon socket ancestor is not trusted")
        }),
    }
    if (!Number.isSafeInteger(options.uid) || options.uid < 0) throw new Error("Invalid OS user identity")
    // Production anchors tmpDir at /tmp, never HOME, TMPDIR, XDG or an Amira config directory.
    const stable = this.privateDirectory(path.join(options.tmpDir, `amira-${options.uid}-workspaces`))
    const workspaceKey = digest(this.workspace).slice(0, 24)
    this.ownershipDirectory = this.privateDirectory(path.join(stable, workspaceKey))
    let base: string | undefined
    if (options.runtimeDir) {
      try {
        this.check(options.runtimeDir, true)
        base = this.privateDirectory(path.join(options.runtimeDir, "amira"))
        // Leave room for the workspace and socket names in sockaddr_un (108 bytes on Linux).
        if (Buffer.byteLength(path.join(base, "0".repeat(24), "daemon.sock")) > 100) base = undefined
      } catch {
        // A rejected XDG root is never modified. The fallback is on the local /tmp filesystem.
      }
    }
    base ??= stable
    this.directory = this.privateDirectory(path.join(base, workspaceKey))
    this.socket = path.join(this.directory, "daemon.sock")
    if (Buffer.byteLength(this.socket) > 100) throw new Error("Remote runtime socket path is too long")
    this.metadataFile = path.join(this.ownershipDirectory, "daemon.json")
  }

  private privateDirectory(file: string): string {
    try {
      mkdirSync(file, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
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
      return strictOwnerState(readFileSync(file, "utf8")) === "dead"
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
    const lock = tryFileLock(file, Infinity, undefined, true)
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
      value = JSON.parse(readFileSync(this.metadataFile, "utf8"))
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
    const meta = value as DaemonMetadata
    if (
      !meta ||
      typeof meta !== "object" ||
      Object.keys(meta).sort().join(",") !==
        "daemonEpoch,lockIdentity,nonce,pid,processIdentity,protocol,release,socket,workspace" ||
      meta.workspace !== this.workspace ||
      typeof meta.socket !== "string" ||
      path.basename(meta.socket) !== "daemon.sock" ||
      path.basename(path.dirname(meta.socket)) !== path.basename(this.ownershipDirectory) ||
      Buffer.byteLength(meta.socket) > 100 ||
      !Number.isSafeInteger(meta.protocol) ||
      !Number.isSafeInteger(meta.pid) ||
      meta.pid < 1 ||
      ![meta.daemonEpoch, meta.processIdentity, meta.nonce, meta.lockIdentity].every(
        (s) => typeof s === "string" && /^[a-zA-Z0-9:._-]{1,256}$/.test(s),
      ) ||
      !meta.release ||
      Object.keys(meta.release).sort().join(",") !== "buildId,target,version" ||
      !Object.values(meta.release).every((s) => typeof s === "string" && s.length > 0 && s.length < 256)
    )
      throw new Error("Invalid daemon metadata")
    if (meta.lockIdentity !== this.lockIdentity()) throw new Error("Daemon owner was replaced")
    return meta
  }

  endpoint(meta: DaemonMetadata): DaemonEndpoint {
    return socketEndpoint(
      { socket: meta.socket, uid: this.uid, pid: meta.pid, processIdentity: meta.processIdentity },
      this.socketChecks,
      this.ownershipDirectory,
      () => {
        this.validate()
        if (meta.workspace !== this.workspace || meta.lockIdentity !== this.lockIdentity())
          throw new Error("Daemon ownership changed before connect")
      },
    )
  }

  private assertOwner(): void {
    this.validate()
    if (!this.owner || this.ownerIdentity !== this.lockIdentity()) throw new Error("Daemon ownership changed")
  }

  publish(meta: DaemonMetadata): void {
    this.assertOwner()
    if (meta.lockIdentity !== this.lockIdentity()) throw new Error("Daemon ownership changed")
    const temp = `${this.metadataFile}.${randomUUID()}`
    try {
      writeFileSync(temp, JSON.stringify(meta), { flag: "wx", mode: 0o600 })
      renameSync(temp, this.metadataFile)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  /** Only a held owner lock permits removing stale sockets/metadata, including after a crash. */
  clearOwnedFiles(): void {
    this.assertOwner()
    let socketError: unknown
    try {
      this.validateSocketDirectory()
      this.check(this.socket, false)
      rmSync(this.socket)
    } catch (error) {
      if (!missing(error)) socketError = error
    }
    // XDG may disappear on logout. Still retire owned stable metadata before releasing the fence.
    try {
      this.check(this.metadataFile, false)
      rmSync(this.metadataFile)
    } catch (error) {
      if (!missing(error)) throw error
    }
    if (socketError) throw socketError
  }

  privateSocket(): void {
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
  const stable = path.join(options.tmpDir, `amira-${options.uid}-workspaces`)
  let keys: string[]
  try {
    keys = readdirSync(stable).filter((key) => /^[a-f0-9]{24}$/.test(key))
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const found: DaemonMetadata[] = []
  for (const key of keys.sort()) {
    try {
      const file = path.join(stable, key, "daemon.json")
      if (lstatSync(file).size > 8192) continue
      const { workspace } = JSON.parse(readFileSync(file, "utf8")) as { workspace?: unknown }
      if (typeof workspace !== "string") continue
      // The workspace's own discovery re-derives the key and applies every ownership/privacy check.
      const discovery = new DaemonDiscovery(workspace, options)
      const meta = path.basename(discovery.ownershipDirectory) === key ? discovery.read() : undefined
      if (meta) found.push(meta)
    } catch {
      // Unreadable, foreign, stale or moved workspaces are simply not listed.
    }
  }
  return found
}
