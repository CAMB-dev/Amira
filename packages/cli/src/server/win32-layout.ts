import { createHash, randomBytes } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { DaemonUnavailableError } from "./fallback.ts"
import type { DaemonLayout } from "./layout.ts"
import {
  createDirectory,
  DRIVE_FIXED,
  DRIVE_REMOTE,
  driveType,
  enableLua,
  FILE_ATTRIBUTE_NOT_CONTENT_INDEXED,
  FILE_ATTRIBUTE_REPARSE_POINT,
  fileAttributes,
  fileSddl,
  localAppData,
  machineGuid,
  processCreationTime,
  setFileAttributes,
  tokenFacts,
} from "./win32-ffi.ts"
import {
  ancestorProblem,
  HIGH_INTEGRITY,
  integrityProblem,
  parseSddl,
  privateDescriptorProblem,
  privateDirectorySddl,
} from "./win32-sddl.ts"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

const pipePattern = /^\\\\\.\\pipe\\amira-[0-9a-f]{32}$/
/** Pipe names are enumerable, so they are not secret: randomness only prevents pre-squatting. */
export const randomPipeName = () => `\\\\.\\pipe\\amira-${randomBytes(16).toString("hex")}`
export const validPipeName = (value: string) => pipePattern.test(value)

/** `(pid, creation time)`; undefined proves the process has exited. */
export function windowsProcessIdentity(pid: number): string | undefined {
  const time = processCreationTime(pid)
  return time === undefined ? undefined : `w:${time}`
}

/**
 * The canonical workspace for a `realpathSync.native` result: junctions, `subst`, 8.3 names and
 * case are already resolved. UNC paths and network drives stay in-process: mapped drives differ
 * between logon sessions and the lease policy assumes a local volume.
 */
export function windowsWorkspace(real: string, typeOfDrive: (root: string) => number): string {
  if (!/^[a-zA-Z]:\\/.test(real)) throw new DaemonUnavailableError("network")
  const workspace = real[0]!.toUpperCase() + real.slice(1)
  const type = typeOfDrive(workspace.slice(0, 3))
  if (type === DRIVE_REMOTE || type < 2) throw new DaemonUnavailableError("network")
  return workspace
}

const busyCodes = new Set(["EPERM", "EBUSY", "EACCES"])
/** Defender, the indexer or backup tools can hold a file open without delete sharing for a moment. */
export function retrySharingViolations<T>(operation: () => T, pause: () => void, attempts = 10): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return operation()
    } catch (error) {
      if (attempt >= attempts || !busyCodes.has((error as NodeJS.ErrnoException).code ?? "")) throw error
      pause()
    }
  }
}

/** Fails with the in-process fallback unless a token at this integrity may run or attach to a daemon. */
export function assertDaemonIntegrity(rid: number, lua: () => number | undefined): void {
  // EnableLUA only matters above Medium, so it is read only then.
  if (integrityProblem(rid, rid >= HIGH_INTEGRITY ? lua() : undefined))
    throw new DaemonUnavailableError("integrity")
}

export interface WindowsLayoutOptions {
  /** Test-only replacement for the LocalAppData known folder; never taken from the environment. */
  root?: string
  /** Test-only trust model for the directories above a temporary root. */
  checkAncestor?: (file: string) => void
  /** Test-only pause between sharing-violation retries. */
  pause?: () => void
  /** Test-only integrity RID and UAC policy in place of this token's. */
  integrity?: { rid: number; enableLua: number | undefined }
}

/**
 * Windows layout: `<LocalAppData>\amira-daemons\<workspace key>\` with protected user+SYSTEM
 * DACLs and a Medium no-read-up label, on a local fixed drive. The top directory is not the
 * installer's `<LocalAppData>\Amira`, whose inherited ACL is not private. The pipe name is
 * recorded in daemon.json. The checks race by path with later reads; only the user or an
 * administrator can write in these directories, so that is accepted rather than claimed atomic.
 */
export function windowsDaemonLayout(options: WindowsLayoutOptions = {}): DaemonLayout {
  const token = tokenFacts()
  const integrity = options.integrity
  if (integrity) assertDaemonIntegrity(integrity.rid, () => integrity.enableLua)
  else assertDaemonIntegrity(token.integrity, enableLua)
  // An elevated administrator's files default to the Administrators owner; both are this principal.
  const principal = { user: token.user, owners: [...new Set([token.user, token.owner])] }
  const root = options.root ?? localAppData()
  if (!/^[a-zA-Z]:\\/.test(root) || driveType(root.slice(0, 3)) !== DRIVE_FIXED)
    throw new DaemonUnavailableError("network")
  const stableRoot = path.join(root, "amira-daemons")
  const descriptor = (file: string) => parseSddl(fileSddl(file))
  const checkAncestor =
    options.checkAncestor ??
    ((file: string) => {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isDirectory() || fileAttributes(file) & FILE_ATTRIBUTE_REPARSE_POINT)
        throw new DaemonUnavailableError("ancestor")
      const parent = path.dirname(file)
      if (ancestorProblem(descriptor(file), parent === file ? undefined : descriptor(parent), principal.user))
        throw new DaemonUnavailableError("ancestor")
    })
  const entryProblem = (file: string, directory: boolean) => {
    const stat = lstatSync(file)
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      fileAttributes(file) & FILE_ATTRIBUTE_REPARSE_POINT
    )
      return "not a private directory or file"
    return privateDescriptorProblem(descriptor(file), principal)
  }
  const checkEntry = (file: string, directory: boolean) => {
    const problem = entryProblem(file, directory)
    if (problem) throw new Error(`Daemon path is not private (${problem})`)
  }
  const checkTop = () => {
    for (let current = root; ; current = path.dirname(current)) {
      checkAncestor(current)
      if (path.dirname(current) === current) break
    }
    // A top directory that someone else made or opened up is a setup the daemon cannot use,
    // not a change under one workspace: it falls back to in-process. Nobody else may rename it.
    if (entryProblem(stableRoot, true)) throw new DaemonUnavailableError("ancestor")
    checkAncestor(stableRoot)
  }
  const guid = machineGuid()
  return {
    principal: { key: digest(principal.user).slice(0, 16), describe: () => `SID ${principal.user}` },
    stableRoot,
    workspaceKey(cwd) {
      const workspace = windowsWorkspace(realpathSync.native(cwd), driveType)
      return { workspace, key: digest(workspace.toLowerCase()).slice(0, 24) }
    },
    checkPrivate(file, directory) {
      if (directory && file === stableRoot) checkTop()
      else checkEntry(file, directory)
    },
    checkAncestor,
    checkEndpoint() {},
    makePrivateDirectory(file) {
      // An existing directory is left untouched; the check that follows decides whether it is ours.
      if (createDirectory(file, privateDirectorySddl(principal.user)))
        setFileAttributes(file, fileAttributes(file) | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)
    },
    endpointFor: randomPipeName,
    validateEndpoint: validPipeName,
    endpointIsFile: false,
    leasePolicy: {
      // The lock lives in a per-user directory on a local fixed volume, so no other machine shares it.
      domain: {
        platform: "win32",
        host: guid ? digest(`win32\n${guid}`) : null,
        legacyHost: null,
        boot: null,
        pidNamespace: null,
      },
      start: windowsProcessIdentity,
    },
    retryBusy: (operation) => retrySharingViolations(operation, options.pause ?? (() => Bun.sleepSync(25))),
  }
}
