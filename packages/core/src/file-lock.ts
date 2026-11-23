import { randomUUID } from "node:crypto"
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

/** A held lock file; release it exactly once. */
export interface FileLock {
  release(): void
}

function readLockInfo(lockPath: string): { pid?: number; nonce?: string; mtimeMs?: number } | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8")
    const mtimeMs = statSync(lockPath).mtimeMs
    const trimmed = raw.trim()
    if (!trimmed) return { mtimeMs }
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as { pid?: unknown; nonce?: unknown }
        const pid =
          typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
            ? parsed.pid
            : undefined
        const nonce = typeof parsed.nonce === "string" ? parsed.nonce : undefined
        return { pid, nonce, mtimeMs }
      } catch {
        return { mtimeMs }
      }
    }
    const [first, second] = trimmed.split(/\r?\n/)
    const parsedPid = Number(first?.trim())
    const pid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined
    const nonce = second?.trim() || undefined
    return { pid, nonce, mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return {}
  }
}

function isStaleLock(
  info: { pid?: number; mtimeMs?: number },
  staleMs: number,
  livePidWins: boolean,
): boolean {
  const validPid = info.pid !== undefined
  if (validPid) {
    if (!isProcessAlive(info.pid!)) return true
    if (livePidWins) return false
  }
  return info.mtimeMs !== undefined && Date.now() - info.mtimeMs > staleMs
}

function publishLock(lockPath: string, body: string): boolean {
  const tmp = `${lockPath}.tmp.${process.pid}.${randomUUID()}`
  writeFileSync(tmp, body, { flag: "wx", mode: 0o600 })
  try {
    linkSync(tmp, lockPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

/**
 * Takes `lockPath` if no other process holds it: the file is published exclusively and records
 * the holder's pid and nonce. A lock whose holder died, or that was not touched for `staleMs`,
 * is taken over atomically (a holder may keep it fresh with `heartbeatMs`). With `livePidWins`,
 * a live holder is never evicted by age alone.
 */
export function tryFileLock(
  lockPath: string,
  staleMs: number,
  heartbeatMs?: number,
  livePidWins = false,
): FileLock | undefined {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  const nonce = randomUUID()
  const body = `${process.pid}\n${nonce}\n${Date.now()}\n`

  for (let attempt = 0; attempt < 2; attempt++) {
    if (publishLock(lockPath, body)) {
      let released = false
      const beat = heartbeatMs
        ? setInterval(() => {
            if (released) return
            const now = new Date()
            try {
              utimesSync(lockPath, now, now)
            } catch {}
          }, heartbeatMs)
        : undefined
      ;(beat as { unref?: () => void } | undefined)?.unref?.()
      return {
        release() {
          if (released) return
          released = true
          if (beat) clearInterval(beat)
          const current = readLockInfo(lockPath)
          if (current?.nonce !== nonce) return
          try {
            rmSync(lockPath, { force: true })
          } catch {}
        },
      }
    }

    if (attempt === 1) return undefined
    const existing = readLockInfo(lockPath)
    if (!existing) continue
    if (!isStaleLock(existing, staleMs, livePidWins)) return undefined

    const stalePath = `${lockPath}.stale.${randomUUID()}`
    try {
      renameSync(lockPath, stalePath)
    } catch {
      return undefined
    }
    try {
      rmSync(stalePath, { force: true })
    } catch {}
  }
  return undefined
}

/** Runs `fn` under a short-lived lock, releasing it immediately on return or throw. */
export function withTransientFileLock<T>(
  lockPath: string,
  fn: () => T,
  staleMs = Number.POSITIVE_INFINITY,
): { value: T } | undefined {
  const lock = tryFileLock(lockPath, staleMs, undefined, true)
  if (!lock) return undefined
  try {
    return { value: fn() }
  } finally {
    lock.release()
  }
}

export interface WaitLockOptions {
  staleMs: number
  /** Give up after waiting this long and throw LockBusyError. */
  waitMs: number
  /** Delay between attempts, in ms. Default 50. */
  pollMs?: number
  heartbeatMs?: number
  signal?: AbortSignal
  /** See `tryFileLock`: a live holder wins over `staleMs`. */
  livePidWins?: boolean
  /** Called once if the first attempt finds the lock held. */
  onWait?: () => void
}

export class LockBusyError extends Error {
  constructor(readonly lockPath: string) {
    super(`another Amira process is using ${path.basename(lockPath)}`)
  }
}

/** Waits for `lockPath` up to `opts.waitMs`, polling every `opts.pollMs`. */
export async function waitFileLock(lockPath: string, opts: WaitLockOptions): Promise<FileLock> {
  const deadline = Date.now() + opts.waitMs
  const pollMs = opts.pollMs ?? 50
  let notified = false
  for (;;) {
    opts.signal?.throwIfAborted()
    const lock = tryFileLock(lockPath, opts.staleMs, opts.heartbeatMs, opts.livePidWins ?? false)
    if (lock) return lock
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new LockBusyError(lockPath)
    if (!notified) {
      notified = true
      opts.onWait?.()
    }
    await sleep(Math.min(pollMs, remaining), opts.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Whether process `pid` still exists. EPERM means another user's live process. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
