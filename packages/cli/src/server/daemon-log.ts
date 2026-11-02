import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs"

const limit = 1024 * 1024

/**
 * `checkPrivate` is the layout's file check. Windows has no O_NOFOLLOW and no POSIX modes, so
 * there it refuses an existing reparse point or foreign file before opening and checks the
 * opened path again; the private directory's inherited ACL replaces fchmod.
 */
export function openDaemonLog(file: string, checkPrivate?: (file: string) => void): number {
  // Without a check (the Linux platform) the POSIX path is unchanged on every OS.
  const windows = process.platform === "win32" && checkPrivate !== undefined
  if (windows) {
    try {
      checkPrivate(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("Daemon log is not an owned regular file")
    if (windows) checkPrivate!(file)
    else fchmodSync(fd, 0o600)
    if (stat.size >= limit) ftruncateSync(fd, 0)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Install only inside the detached process, before composing runtime or extensions. */
export function capDaemonOutput(): void {
  let remaining = Math.max(0, limit - fstatSync(2).size)
  const write = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    const length = Math.min(remaining, bytes.length)
    if (length) {
      try {
        writeSync(2, bytes.subarray(0, length))
      } catch {}
      remaining -= length
    }
    const done = typeof encoding === "function" ? encoding : callback
    if (typeof done === "function") queueMicrotask(() => done())
    return true
  }
  process.stdout.write = write as typeof process.stdout.write
  process.stderr.write = write as typeof process.stderr.write
}
