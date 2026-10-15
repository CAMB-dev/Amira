import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { existingPrefix, safeName, safeParents, within } from "./permissions/path-containment.ts"
import { type ProtectOptions, toolPath } from "./permissions/protected.ts"

/** Host-owned registration context, never a tool declaration or a model argument. */
export interface ExtensionDataOwner {
  readonly home: string
  readonly dataDir: string
}

type Containment = "inside" | "outside" | "unknown"

/** One safe segment, including a digest of the original (not case-folded or truncated) identity. */
export function extensionDataOwner(home: string, identity: string, create = true): ExtensionDataOwner {
  if (!identity.isWellFormed()) throw new Error("Extension data identity must be well-formed Unicode")
  const slug =
    identity
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .slice(0, 48) || "extension"
  const digest = createHash("sha256").update(identity).digest("hex")
  const owner = Object.freeze({ home, dataDir: path.join(home, "extension-data", `ext-${slug}-${digest}`) })
  // Registration checks the namespace; first API access checks again before and after creation.
  if (!ownerRoot(owner)) throw new Error("Cannot safely resolve the extension data directory")
  if (create) {
    mkdirSync(owner.dataDir, { recursive: true })
    if (!ownerRoot(owner)) throw new Error("Cannot safely resolve the extension data directory")
  }
  return owner
}

/**
 * Proof for the protected-write exception, not a sandbox: paths can race with execution and
 * realpath does not prove exclusive ownership of hard links. Reports must use file-tool semantics.
 */
export function extensionDataContainment(
  owner: ExtensionDataOwner,
  cwd: string,
  reported: string,
  opts: ProtectOptions = {},
): Containment {
  // Native identity cannot be established by simulating another platform's path syntax.
  if (opts.platform && opts.platform !== process.platform) return "unknown"
  try {
    const root = ownerRoot(owner)
    if (!root) return "unknown"
    const input = safeName(reported, false)
    if (input === undefined || !safeParents(cwd, input, opts)) return "unknown"
    const abs = safeName(toolPath(cwd, reported, opts), true)
    if (!abs) return "unknown"
    const real = existingPrefix(abs)
    if (!real) return "unknown"
    return within(real, root) ? "inside" : "outside"
  } catch {
    return "unknown"
  }
}

/** Canonicalize home first; neither extension-data nor the owner root may redirect elsewhere. */
function ownerRoot(owner: ExtensionDataOwner): string | undefined {
  try {
    const home = safeName(owner.home, true)
    const dir = safeName(owner.dataDir, true)
    if (!home || !dir || path.dirname(dir) !== path.join(home, "extension-data")) return undefined
    const realHome = existingPrefix(home, true)
    if (!realHome) return undefined
    const namespace = existingPrefix(path.join(home, "extension-data"), true)
    if (!namespace || namespace !== path.join(realHome, "extension-data")) return undefined
    const realDir = existingPrefix(dir, true)
    return realDir === path.join(namespace, path.basename(dir)) ? realDir : undefined
  } catch {
    return undefined
  }
}
