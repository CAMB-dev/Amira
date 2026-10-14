import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fstatSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import {
  pendingGateCleanup,
  pendingOwnedGate,
  takeFilesystemGate,
  withFilesystemGateAttempt,
} from "./file-lock-gate.ts"
import { leaseOwner, strictOwnerState } from "./file-lock-owner.ts"

// Only release-requested leases enter this registry; a live pid never grants cleanup
// authority. Callbacks retain the original parent, inode and immutable nonce proof.
type OwnedCleanup = (() => void) & { owns?: () => boolean }
const pendingStrictReleases = new Map<string, Set<OwnedCleanup>>()
// Private publication debris has no authority over the canonical lease or its fd.
const pendingPrivateCleanups = new Map<string, Set<() => void>>()
let strictExiting = false
process.on("exit", () => {
  // Gate finalization runs first; retry requested leases under the newly available
  // authority, or close their retained descriptors after one final failed attempt.
  strictExiting = true
  for (const registry of [pendingStrictReleases, pendingPrivateCleanups])
    for (const callbacks of registry.values()) for (const cleanup of callbacks) cleanup()
})
function strictReleaseKey(lockPath: string): string {
  const key = path.join(realpathSync(path.dirname(path.resolve(lockPath))), path.basename(lockPath))
  return process.platform === "win32" ? key.toLowerCase() : key
}

/** A query never takes authority or runs cleanup; foreign replacements fail closed. */
export function pendingOwnedLockCleanup(blockingPath: string): boolean {
  if (blockingPath.endsWith(".lease-gate")) return pendingOwnedGate(blockingPath)
  try {
    for (const cleanup of pendingStrictReleases.get(strictReleaseKey(blockingPath)) ?? [])
      if (cleanup.owns?.()) return true
  } catch {}
  return false
}

/** Cleanup status, not authority: include every queued callback even after its parent moves. */
export function pendingFileLockCleanup(canonicalLockPath: string): boolean {
  const key = process.platform === "win32" ? canonicalLockPath.toLowerCase() : canonicalLockPath
  return (
    !!pendingStrictReleases.get(key)?.size ||
    !!pendingPrivateCleanups.get(key)?.size ||
    pendingGateCleanup(`${canonicalLockPath}.lease-gate`)
  )
}

/** A held lock file; release it exactly once. */
export interface FileLock {
  release(): void
}

/**
 * Takes `lockPath` if no other process holds it: the file is created exclusively and records
 * the holder's pid. A lock whose holder died, or that was not touched for `staleMs`, is taken
 * over (a holder may keep it fresh with `heartbeatMs`). With `livePidWins`, owner records
 * require proof of death in the same host/PID domain; age alone never grants authority.
 * Legacy bare-pid, empty or unparseable single-line leases require BOTH age over `staleMs`
 * and a provably dead local pid (or no valid pid). Live pids and fresh legacy leases block.
 * Recovery rechecks identity and freshness under the same gate, including the moved file. All new
 * participants must use this mode; older builds must heartbeat. Foreign or invalid owner
 * records and unknown gates still fail closed. `onGuardBusy` receives the blocking
 * guard or unverifiable lease path; a missing guard means publication lost a concurrent race.
 * Undefined when another live process holds it. Other errors (no permission, ...) are thrown.
 */
export function tryFileLock(
  lockPath: string,
  staleMs: number,
  heartbeatMs?: number,
  livePidWins = false,
  onGuardBusy?: (gatePath: string) => void,
): FileLock | undefined {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  if (livePidWins) {
    return withFilesystemGateAttempt(() => {
      const key = strictReleaseKey(lockPath)
      for (const registry of [pendingStrictReleases, pendingPrivateCleanups])
        for (const cleanup of registry.get(key) ?? []) cleanup()
      const unlock = takeFilesystemGate(lockPath)
      if (!unlock) {
        onGuardBusy?.(`${lockPath}.lease-gate`)
        return undefined
      }
      try {
        if (!restoreLegacyLease(lockPath, onGuardBusy)) return undefined
        return (
          createStrict(lockPath, heartbeatMs) ??
          (removeStrictIfDead(lockPath, staleMs, onGuardBusy)
            ? createStrict(lockPath, heartbeatMs)
            : undefined)
        )
      } finally {
        unlock()
      }
    })
  }
  return (
    create(lockPath, heartbeatMs) ??
    (removeIfStale(lockPath, staleMs) ? create(lockPath, heartbeatMs) : undefined)
  )
}

/**
 * A synchronous unclaimed write needs authority only until it returns. Batch lease proof
 * and the mutation under one gate instead of publishing a lease and taking a second gate
 * to release it. Persistent claim/release/recovery use this same gate, so none can overlap.
 * A crash is fenced by the gate owner's death proof just as in persistent acquisition.
 */
export function withTransientFileLock<T>(
  lockPath: string,
  write: () => T & (T extends PromiseLike<unknown> ? never : unknown),
  onGuardBusy: (gatePath: string) => void,
  staleMs = Infinity,
): { value: T } | undefined {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  return withFilesystemGateAttempt(() => {
    const key = strictReleaseKey(lockPath)
    for (const registry of [pendingStrictReleases, pendingPrivateCleanups])
      for (const cleanup of registry.get(key) ?? []) cleanup()
    const unlock = takeFilesystemGate(lockPath)
    if (!unlock) {
      onGuardBusy(`${lockPath}.lease-gate`)
      return undefined
    }
    try {
      if (!restoreLegacyLease(lockPath, onGuardBusy)) return undefined
      if (!removeStrictIfDead(lockPath, staleMs, onGuardBusy)) return undefined
      return { value: write() }
    } finally {
      unlock()
    }
  })
}

/** A moved legacy lease remains authority even across failed rollback or a crash. */
function restoreLegacyLease(lockPath: string, onGuardBusy?: (ownerPath: string) => void): boolean {
  const aside = `${lockPath}.legacy-stale`
  let moved: ReturnType<typeof lstatSync>
  try {
    moved = lstatSync(aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
  }
  if (moved?.isFile()) {
    try {
      try {
        linkSync(aside, lockPath)
      } catch (error) {
        // A crash after linking may leave both names for the same inode. Nothing else
        // grants permission to discard the recovery fence or overwrite the canonical lease.
        const current = lstatSync(lockPath)
        if (!current.isFile() || current.dev !== moved.dev || current.ino !== moved.ino) throw error
      }
      rmSync(aside, { force: true })
      return true
    } catch {}
  }
  onGuardBusy?.(aside)
  return false
}

/** Never downgrade a multiline or structured owner record to a legacy pid. */
function legacyLockPid(contents: string): number | null | undefined {
  if (!/^[^\r\n]*(?:\r?\n)?$/.test(contents) || /^[{[]/.test(contents.trim())) return undefined
  const pid = Number(contents.trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** A failed or unavailable process probe is not proof of death. */
function legacyPidDead(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

/** The exclusively published gate spans lease proof, identity recheck and retirement. */
function removeStrictIfDead(
  lockPath: string,
  staleMs: number,
  onGuardBusy?: (ownerPath: string) => void,
): boolean {
  let identity: ReturnType<typeof statSync>
  let contents: string
  let state: ReturnType<typeof strictOwnerState> = "unknown"
  let recoverable = false
  let legacy = false
  const matchesProof = (file: string) => {
    if (!identity) return false
    const currentContents = readFileSync(file, "utf8")
    const current = lstatSync(file)
    return (
      current.isFile() &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      current.mtimeMs === identity.mtimeMs &&
      current.size === identity.size &&
      currentContents === contents
    )
  }
  try {
    identity = statSync(lockPath)
    if (identity.isFile()) {
      contents = readFileSync(lockPath, "utf8")
      state = strictOwnerState(contents)
      const pid = state === "unknown" ? legacyLockPid(contents) : undefined
      legacy = pid !== undefined
      recoverable =
        state === "dead" ||
        (pid !== undefined && Date.now() - identity.mtimeMs > staleMs && (pid === null || legacyPidDead(pid)))
      // Older builds do not take this gate: reject a replacement or heartbeat during proof.
      if (recoverable) recoverable = matchesProof(lockPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    recoverable = false
  }
  if (!recoverable) {
    if (state !== "live") onGuardBusy?.(lockPath)
    return false
  }
  // A fixed legacy retirement path is checked before every subsequent acquisition.
  // Unlike private owner-record debris, it must fence a possibly live older holder.
  const aside = legacy ? `${lockPath}.legacy-stale` : `${lockPath}.stale-${process.pid}-${randomUUID()}`
  renameSync(lockPath, aside)
  if (legacy) {
    // Bind the proof to the inode actually moved: an older writer may ignore our gate.
    let verified = false
    try {
      verified = matchesProof(aside)
    } catch {}
    if (!verified) {
      if (!restoreLegacyLease(lockPath, onGuardBusy)) return false
      onGuardBusy?.(lockPath)
      return false
    }
  }
  rmSync(aside, { force: true })
  return true
}

/** Gate contention is not evidence that a different process owns the session lease. */
export class SessionWriteGuardError extends Error {
  /** Internal acquisition hint, never authority to reclaim anything. */
  readonly pendingOwnedCleanup: boolean
  constructor(readonly gatePath: string) {
    let legacy = false
    try {
      legacy =
        !gatePath.endsWith(".lease-gate") &&
        lstatSync(gatePath).isFile() &&
        legacyLockPid(readFileSync(gatePath, "utf8")) !== undefined
    } catch {}
    super(
      legacy
        ? `an older Amira build appears to hold the session: ${gatePath}; close it before resuming or deleting the session, then retry; if it crashed, wait for its lease to become stale`
        : `session stale-write guard is busy or unverifiable: ${gatePath}; retry${
            existsSync(gatePath)
              ? `, or remove this ${gatePath.endsWith(".lease-gate") ? "directory" : "lease file"} manually only after confirming no Amira process is running on any host using these session files`
              : "; no guard exists at this path yet, so do not remove any files"
          }`,
    )
    this.pendingOwnedCleanup = pendingOwnedLockCleanup(gatePath)
  }
}

export interface WaitLockOptions {
  staleMs: number
  /** Give up after this long; default: as long as the lock could be held (staleMs). */
  waitMs?: number
  signal?: AbortSignal
  /** Called once when the lock is busy and this starts waiting. */
  onWait?: () => void
  pollMs?: number
  /** Refreshes the lock file this often while it is held, for holds that may outlast staleMs. */
  heartbeatMs?: number
}

/** Waits until `lockPath` can be taken; throws `LockBusyError` after `waitMs`, or the abort reason. */
export async function waitFileLock(lockPath: string, opts: WaitLockOptions): Promise<FileLock> {
  const deadline = Date.now() + (opts.waitMs ?? opts.staleMs)
  let waited = false
  for (;;) {
    opts.signal?.throwIfAborted()
    const lock = tryFileLock(lockPath, opts.staleMs, opts.heartbeatMs)
    if (lock) return lock
    if (Date.now() >= deadline) throw new LockBusyError(lockPath)
    if (!waited) opts.onWait?.()
    waited = true
    await sleep(opts.pollMs ?? 100, opts.signal)
  }
}

export class LockBusyError extends Error {
  override name = "LockBusyError"
  constructor(readonly lockPath: string) {
    super(`${lockPath} is held by another amira process; if none is running, delete it`)
  }
}

/** One bounded chain shared by release-requested leases and private publication debris. */
function ownedCleanup(
  key: string,
  registry: Map<string, Set<OwnedCleanup>>,
  label: string,
  attempt: () => string | undefined,
  close?: () => void,
  owns?: () => boolean,
): OwnedCleanup {
  let finished = false
  let attempts = 0
  let warned = false
  let cleaning = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanup: OwnedCleanup = () =>
    withFilesystemGateAttempt(() => {
      if (cleaning || finished) return
      // Explicit retry keeps the existing automatic budget/timer; it never restarts it.
      cleaning = true
      let failure: string | undefined
      let retry = false
      try {
        failure = attempt()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EPERM" || code === "EBUSY" || code === "EACCES") failure = code
        // Missing/replaced/unverifiable paths grant no cleanup authority.
      }
      try {
        if (failure !== undefined) {
          const callbacks = registry.get(key) ?? new Set<() => void>()
          callbacks.add(cleanup)
          registry.set(key, callbacks)
          if (strictExiting) {
            clearTimeout(timer)
            timer = undefined
          }
          if (!strictExiting && timer) retry = true
          else if (!strictExiting && attempts++ < 10) {
            retry = true
            timer = setTimeout(() => {
              timer = undefined
              cleanup()
            }, 100)
            timer.unref()
          } else if (!warned) {
            warned = true
            try {
              process.emitWarning(`${label}: ${failure}; owned cleanup remains pending`)
            } catch {}
          }
        } else {
          finished = true
          clearTimeout(timer)
          timer = undefined
          const callbacks = registry.get(key)
          callbacks?.delete(cleanup)
          if (!callbacks?.size) registry.delete(key)
        }
      } finally {
        if (!retry) close?.()
        cleaning = false
      }
    })
  cleanup.owns = owns
  return cleanup
}

/** Called only while holding the strict gate. */
function createStrict(lockPath: string, heartbeatMs?: number): FileLock | undefined {
  // Initialize a private inode, then publish exclusively. A crash between open and write
  // must not leave an empty lease that a dead gate cannot safely attribute to its owner.
  const parent = path.dirname(lockPath)
  const key = strictReleaseKey(lockPath)
  const parentIdentity = statSync(parent)
  const pending = `${lockPath}.pending-${process.pid}-${randomUUID()}`
  const owner = leaseOwner()
  const contents = `${owner.pid}\n${owner.nonce}\n${JSON.stringify(owner)}\n`
  const fd = openSync(pending, "wx")
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      closeSync(fd)
    } catch {}
  }
  const sameParent = () => {
    const current = statSync(parent)
    return current.dev === parentIdentity.dev && current.ino === parentIdentity.ino
  }
  let identity: ReturnType<typeof fstatSync> | undefined
  let privateContents: string | undefined = ""
  const privateCleanup = ownedCleanup(
    key,
    pendingPrivateCleanups,
    `FileLock private cleanup failed: ${pending}`,
    () => {
      if (!identity || privateContents === undefined || !sameParent()) return
      const current = lstatSync(pending)
      if (
        current.isFile() &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        readFileSync(pending, "utf8") === privateContents
      )
        rmSync(pending, { force: true })
    },
  )
  try {
    identity = fstatSync(fd)
    privateContents = undefined
    writeFileSync(fd, contents)
    privateContents = contents
    linkSync(pending, lockPath)
  } catch (err) {
    // Capture even a partially initialized private inode, without masking the original
    // publication error. An unpublished descriptor is never retained for debris cleanup.
    if (privateContents === undefined && identity) {
      try {
        const current = lstatSync(pending)
        if (sameParent() && current.dev === identity.dev && current.ino === identity.ino)
          privateContents = readFileSync(pending, "utf8")
      } catch {}
    }
    close()
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined
    throw err
  } finally {
    // Publication already owns fd: private cleanup must never invalidate that handle.
    privateCleanup()
  }
  const beat = heartbeatMs
    ? setInterval(() => {
        try {
          const now = new Date()
          // Refresh the held inode, not a replacement at the same pathname.
          futimesSync(fd, now, now)
        } catch {}
      }, heartbeatMs)
    : undefined
  beat?.unref?.()
  const cleanup = ownedCleanup(
    key,
    pendingStrictReleases,
    `FileLock release cleanup failed: ${lockPath}`,
    () => {
      if (!sameParent()) return
      const unlock = takeFilesystemGate(lockPath)
      if (!unlock) return `filesystem gate ${lockPath}.lease-gate remains busy`
      try {
        if (!sameParent()) return
        const current = lstatSync(lockPath)
        if (
          current.isFile() &&
          current.dev === identity!.dev &&
          current.ino === identity!.ino &&
          readFileSync(lockPath, "utf8") === contents
        )
          rmSync(lockPath, { force: true })
      } finally {
        try {
          unlock()
        } catch {}
      }
    },
    close,
    () => {
      if (!sameParent()) return false
      const current = lstatSync(lockPath)
      return (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === identity!.dev &&
        current.ino === identity!.ino &&
        readFileSync(lockPath, "utf8") === contents
      )
    },
  )
  return {
    release() {
      clearInterval(beat)
      privateCleanup()
      // Exhaustion closes fd, but keeps only this requested inode/nonce proof retryable.
      cleanup()
    },
  }
}

function create(lockPath: string, heartbeatMs?: number): FileLock | undefined {
  let fd: number
  try {
    fd = openSync(lockPath, "wx")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined
    throw err
  }
  try {
    writeSync(fd, `${process.pid}\n`)
  } catch {}
  // A long hold keeps its lock fresh, so that only a lock whose holder stopped looks stale.
  const beat = heartbeatMs
    ? setInterval(() => {
        try {
          const now = new Date()
          utimesSync(lockPath, now, now)
        } catch {}
      }, heartbeatMs)
    : undefined
  beat?.unref?.()
  let released = false
  return {
    release() {
      if (released) return
      released = true
      clearInterval(beat)
      try {
        closeSync(fd)
      } catch {}
      rmSync(lockPath, { force: true })
    },
  }
}

/**
 * Removes a lock whose holder died or that was not refreshed for `staleMs`. It is renamed away
 * first, so of two processes taking over the same stale lock only one succeeds; a fresh lock
 * renamed by mistake (another process took over in between) is put back.
 */
function removeIfStale(lockPath: string, staleMs: number): boolean {
  let pid: number
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs
    pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10)
    // An empty file: the holder has not written its pid yet (or is an older amira); go by age.
    const validPid = Number.isSafeInteger(pid) && pid > 0
    const holderGone = validPid && !isProcessAlive(pid)
    if (!holderGone && age < staleMs) return false
  } catch {
    // Released in the meantime.
    return true
  }
  const aside = `${lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    renameSync(lockPath, aside)
  } catch {
    // Someone else took it over (or it was released): try again from the start.
    return true
  }
  try {
    const moved = Number.parseInt(readFileSync(aside, "utf8"), 10)
    if (moved !== pid && !(Number.isNaN(moved) && Number.isNaN(pid))) {
      // Not the lock judged stale: put it back unless a newer one is already there.
      try {
        linkSync(aside, lockPath)
      } catch {}
      return false
    }
  } catch {
  } finally {
    rmSync(aside, { force: true })
  }
  return true
}

/** Whether a process with this pid exists (EPERM: it does, but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(t)
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
