import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import type { LeasePolicy } from "../../../core/src/file-lock-owner.ts"

/** The OS account that owns a daemon namespace. Its key appears only in private directory names. */
export interface DaemonPrincipal {
  key: string
  /** Diagnostics only. */
  describe(): string
}

/** Where one OS keeps private discovery files, and how it proves they are private. */
export interface DaemonLayout {
  principal: DaemonPrincipal
  /** Parent of every workspace's ownership directory; the same for every login of the principal. */
  stableRoot: string
  /** Optional per-login root for endpoints; rejected or missing roots fall back to stableRoot. */
  runtimeRoot?: string
  workspaceKey(cwd: string): { workspace: string; key: string }
  checkPrivate(file: string, directory: boolean): void
  checkAncestor(file: string): void
  /** Endpoint-specific check after checkPrivate, such as the socket file type. */
  checkEndpoint(file: string): void
  makePrivateDirectory(file: string): void
  endpointFor(directory: string): string
  /** Whether a recorded endpoint has this layout's form for the workspace key. */
  validateEndpoint(value: string, key: string): boolean
  /** False when the endpoint is not a file (a pipe name), so discovery never removes or chmods it. */
  endpointIsFile: boolean
  /** Undefined keeps core's default lease domain and PID probe. */
  leasePolicy?: LeasePolicy
  /** Wraps metadata publish and read where scanners can briefly hold files open (Windows). */
  retryBusy?<T>(operation: () => T): T
}

export interface PosixLayoutOptions {
  /** Accepted for source compatibility; never participates in workspace ownership. */
  home?: string
  runtimeDir?: string
  tmpDir: string
  /** The decimal OS uid. */
  principal: string
  /** Tests supply a permission model; production always checks POSIX ownership and modes. */
  checkPrivate?: (file: string, directory: boolean) => void
  /** Socket/ancestor permission models are injectable only for non-POSIX test filesystems. */
  checkSocket?: (file: string) => void
  checkAncestor?: (file: string) => void
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** Linux layout: the stable fence under tmpDir, sockets under a private XDG runtime root when it fits. */
export function posixDaemonLayout(options: PosixLayoutOptions): DaemonLayout {
  if (!/^(?:0|[1-9]\d{0,15})$/.test(options.principal) || !Number.isSafeInteger(Number(options.principal)))
    throw new Error("Invalid OS user identity")
  const uid = Number(options.principal)
  return {
    principal: { key: options.principal, describe: () => `uid ${uid}` },
    stableRoot: path.join(options.tmpDir, `amira-${options.principal}-workspaces`),
    runtimeRoot: options.runtimeDir,
    workspaceKey(cwd) {
      const workspace = realpathSync(cwd)
      return { workspace, key: digest(workspace).slice(0, 24) }
    },
    checkPrivate:
      options.checkPrivate ??
      ((file, directory) => {
        const stat = lstatSync(file)
        if (
          stat.isSymbolicLink() ||
          (directory ? !stat.isDirectory() : !stat.isFile() && !stat.isSocket()) ||
          stat.uid !== uid ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error("Remote runtime path is not private and owned")
      }),
    checkAncestor:
      options.checkAncestor ??
      ((file) => {
        const stat = lstatSync(file)
        const trustedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0
        if (
          stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          (stat.uid !== 0 && stat.uid !== uid) ||
          ((stat.mode & 0o022) !== 0 && !trustedSticky)
        )
          throw new Error("Daemon socket ancestor is not trusted")
      }),
    checkEndpoint(file) {
      if (options.checkSocket) options.checkSocket(file)
      else if (!lstatSync(file).isSocket()) throw new Error("Daemon endpoint is not a private socket")
    },
    makePrivateDirectory(file) {
      try {
        mkdirSync(file, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    },
    endpointFor: (directory) => path.join(directory, "daemon.sock"),
    // Leave room in sockaddr_un (108 bytes on Linux).
    validateEndpoint: (value, key) =>
      path.basename(value) === "daemon.sock" &&
      path.basename(path.dirname(value)) === key &&
      Buffer.byteLength(value) <= 100,
    endpointIsFile: true,
  }
}
