import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import path from "node:path"

/** A held lock file; release it exactly once. */
export interface FileLock {
  release(): void
}

/**
 * Takes `lockPath` if no other process holds it: the file is created exclusively and records
 * the holder's pid. A lock whose holder died, or that is older than `staleMs`, is taken over.
 * Undefined when another live process holds it. Other errors (no permission, ...) are thrown.
 */
export function tryFileLock(lockPath: string, staleMs: number): FileLock | undefined {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  return create(lockPath) ?? (removeIfStale(lockPath, staleMs) ? create(lockPath) : undefined)
}

export interface WaitLockOptions {
  staleMs: number
  /** Give up after this long; default: as long as the lock could be held (staleMs). */
  waitMs?: number
  signal?: AbortSignal
  /** Called once when the lock is busy and this starts waiting. */
  onWait?: () => void
  pollMs?: number
}

/** Waits until `lockPath` can be taken; throws `LockBusyError` after `waitMs`, or the abort reason. */
export async function waitFileLock(lockPath: string, opts: WaitLockOptions): Promise<FileLock> {
  const deadline = Date.now() + (opts.waitMs ?? opts.staleMs)
  let waited = false
  for (;;) {
    opts.signal?.throwIfAborted()
    const lock = tryFileLock(lockPath, opts.staleMs)
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

function create(lockPath: string): FileLock | undefined {
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
  let released = false
  return {
    release() {
      if (released) return
      released = true
      try {
        closeSync(fd)
      } catch {}
      rmSync(lockPath, { force: true })
    },
  }
}

function removeIfStale(lockPath: string, staleMs: number): boolean {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs
    const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10)
    // An empty file: the holder has not written its pid yet (or is an older amira); go by age.
    const holderGone = Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid)
    if (!holderGone && age < staleMs) return false
    rmSync(lockPath, { force: true })
    return true
  } catch {
    // Released in the meantime.
    return true
  }
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
