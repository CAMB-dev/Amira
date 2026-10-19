import type { OwnedSessionIdentity } from "./owned-session.ts"
import { validateStoredWriteRoots, validateWriteRoots, writeRootPolicy } from "./permissions/write-roots.ts"

export interface SessionHeader {
  /** Policy-bearing headers use a discriminator rejected even by legacy parsers that ignore v. */
  type: "session" | "session-policy" | "session-lifecycle"
  v: 1 | 2 | 3
  writeRoots?: readonly string[]
  id: string
  cwd: string
  createdAt: string
  /** The session this one was forked from, if any. */
  parent: string | null
  /** Host-owned policy identity; not resumable or forkable as an ordinary root. */
  owned?: OwnedSessionIdentity
}

export function isSessionHeader(value: unknown, options?: { historical?: boolean }): value is SessionHeader {
  const validateRoots = options?.historical ? validateStoredWriteRoots : validateWriteRoots
  const h = value as SessionHeader | undefined
  if (!h || typeof h.id !== "string" || (h.v !== 1 && h.v !== 2 && h.v !== 3)) return false
  if (h.type !== (h.v === 3 ? "session-lifecycle" : h.v === 2 ? "session-policy" : "session")) return false
  if (h.v === 3 && h.owned?.v !== 3) return false
  try {
    if (h.v === 1 && h.writeRoots !== undefined) return false
    if (
      h.writeRoots !== undefined &&
      JSON.stringify(validateRoots(h.writeRoots)) !== JSON.stringify(h.writeRoots)
    )
      return false
    if (h.owned !== undefined) {
      const o = h.owned
      if (
        !o ||
        (o.v !== 1 && o.v !== 2 && o.v !== 3) ||
        typeof o.owner !== "string" ||
        !o.spec ||
        !Array.isArray(o.runtimeTools)
      )
        return false
      if (Object.keys(o).some((key) => !["v", "owner", "spec", "runtimeTools"].includes(key))) return false
      if (
        Object.keys(o.spec).some(
          (key) =>
            ![
              "key",
              "name",
              "cwd",
              "model",
              "systemPrompt",
              "callableTools",
              "writeRoots",
              "descendants",
            ].includes(key),
        )
      )
        return false
      if (
        o.spec.descendants !== undefined &&
        o.spec.descendants !== "research" &&
        o.spec.descendants !== "inherit"
      )
        return false
      if (o.v === 1 && (o.spec.writeRoots !== undefined || o.spec.descendants === "inherit")) return false
      if (o.v !== 1 && h.v !== o.v) return false
      if (
        o.spec.writeRoots !== undefined &&
        JSON.stringify(validateRoots(o.spec.writeRoots)) !== JSON.stringify(o.spec.writeRoots)
      )
        return false
    }
    if (
      h.v !== 1 &&
      Object.keys(h).some(
        (key) => !["type", "v", "id", "cwd", "createdAt", "parent", "owned", "writeRoots"].includes(key),
      )
    )
      return false
    // Only executable opens establish a ceiling against today's filesystem.
    if (!options?.historical) {
      if (h.writeRoots !== undefined) writeRootPolicy(Object.freeze(h.writeRoots)).assertUnchanged()
      if (h.owned?.spec.writeRoots !== undefined)
        writeRootPolicy(Object.freeze(h.owned.spec.writeRoots)).assertUnchanged()
    }
    return true
  } catch {
    return false
  }
}
