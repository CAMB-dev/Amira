import path from "node:path"
import { tryFileLock } from "@amira/core"

/** Shared with both installers. Never hold this gate while fetching release metadata or archives. */
export const RETENTION_GATE = "retention.lock"
export const RETENTION_WAIT_MS = 250

export async function withRetentionGate<T>(root: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + RETENTION_WAIT_MS
  for (;;) {
    const lock = tryFileLock(path.join(root, RETENTION_GATE), 10 * 60_000, undefined, true)
    if (lock) {
      try {
        return await work()
      } finally {
        lock.release()
      }
    }
    if (Date.now() >= deadline) throw new Error("Amira version retention is busy")
    await Bun.sleep(10)
  }
}
