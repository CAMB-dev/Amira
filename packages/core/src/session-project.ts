import { createHash } from "node:crypto"
import path from "node:path"
import { amiraPath } from "./home.ts"

/** Stable per-directory storage key, case-insensitive on Windows. */
export function projectKey(cwd: string): string {
  const key = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd)
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/** Ordinary root sessions live here; extension-owned histories use a separate namespace. */
export function sessionsDir(cwd: string): string {
  return amiraPath("sessions", projectKey(cwd))
}
