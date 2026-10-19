import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export type OwnedLifecycleState = "active" | "archiving" | "archived"

export function isOwnedLifecycleState(value: unknown): value is OwnedLifecycleState {
  return value === "active" || value === "archiving" || value === "archived"
}

/** Publish whole owned records without exposing torn contents or losing a completed rename. */
export function writeOwnedFile(file: string, bytes: string | Uint8Array): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, "wx", 0o600)
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    // Node cannot open directory handles for fsync on Windows.
    if (process.platform !== "win32") {
      const dir = openSync(path.dirname(file), "r")
      try {
        fsyncSync(dir)
      } finally {
        closeSync(dir)
      }
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}
