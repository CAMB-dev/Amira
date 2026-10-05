import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { type ProtectOptions, toolPath } from "./permissions/protected.ts"

/** Host-owned registration context, never a tool declaration or a model argument. */
export interface ExtensionDataOwner {
  readonly home: string
  readonly dataDir: string
}

type Containment = "inside" | "outside" | "unknown"

/** One safe segment, including a digest of the original (not case-folded or truncated) identity. */
export function extensionDataOwner(home: string, identity: string): ExtensionDataOwner {
  if (!identity.isWellFormed()) throw new Error("Extension data identity must be well-formed Unicode")
  const slug =
    identity
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .slice(0, 48) || "extension"
  const digest = createHash("sha256").update(identity).digest("hex")
  const owner = Object.freeze({ home, dataDir: path.join(home, "extension-data", `ext-${slug}-${digest}`) })
  // Loading creates the persistent directory, but must not follow a redirected data namespace.
  if (!ownerRoot(owner)) throw new Error("Cannot safely resolve the extension data directory")
  mkdirSync(owner.dataDir, { recursive: true })
  if (!ownerRoot(owner)) throw new Error("Cannot safely resolve the extension data directory")
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

/** Normalizing link/.. can hide native traversal outside the reported directory. */
function safeParents(cwd: string, input: string, opts: ProtectOptions): boolean {
  const parents = process.platform === "win32" ? /(^|[\\/])\.\.(?=$|[\\/])/g : /(^|\/)\.\.(?=$|\/)/g
  for (const match of input.matchAll(parents)) {
    const prefix = input.slice(0, match.index + match[1]!.length)
    // Remove trailing separators through toolPath so lstat inspects the link itself.
    const entry = lstatSync(toolPath(cwd, prefix || ".", opts))
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false
  }
  return true
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

/** Only ENOENT on a genuinely absent entry permits appending a nonexistent suffix. */
function existingPrefix(abs: string, directory = false): string | undefined {
  let current = abs
  const suffix: string[] = []
  for (let i = 0; i < 128; i++) {
    try {
      // lstat finds dangling links too. A failure resolving one must not be walked past.
      lstatSync(current)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return undefined
      const parent = path.dirname(current)
      if (parent === current) return undefined
      suffix.push(path.basename(current))
      current = parent
      continue
    }
    try {
      const real = safeName(realpathSync.native(current), true)
      if (!real || ((suffix.length || directory) && !statSync(current).isDirectory())) return undefined
      return suffix.length ? path.join(real, ...suffix.reverse()) : real
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Reject ambiguous Windows aliases rather than use protection's permissive alias recognizer.
 * Native realpath expands existing case/8.3 aliases. Do not fold path components: Windows
 * directories can be case-sensitive too. Drive and UNC roots alone are case-insensitive.
 */
function safeName(input: string, absolute: boolean): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid path reports
  if (!input || /[\x00-\x1f\x7f]/.test(input)) return undefined
  let name = input
  if (process.platform === "win32") {
    name = name.replaceAll("/", "\\")
    if (/^\\\\\?\\UNC\\/i.test(name)) name = `\\\\${name.slice(8)}`
    else if (/^\\\\\?\\[a-z]:\\/i.test(name)) name = name.slice(4)
    else if (/^\\\\[?.]\\|^\\\?\?\\/.test(name)) return undefined
    if (/^[a-z]:(?!\\)/i.test(name)) return undefined
    const body = name.replace(/^[a-z]:/i, "")
    for (const segment of body.split("\\").filter(Boolean)) {
      if (segment === "." || segment === "..") continue
      if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) return undefined
      if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) return undefined
    }
    if (name.startsWith("\\\\") && body.split("\\").filter(Boolean).length < 2) return undefined
  }
  if (!absolute) return name
  if (!path.isAbsolute(name)) return undefined
  name = path.normalize(name)
  if (process.platform === "win32") {
    const root = path.parse(name).root
    const canonicalRoot = /^[a-z]:/i.test(root) ? root.toUpperCase() : root.toLowerCase()
    name = canonicalRoot + name.slice(root.length)
  }
  return name
}

/** Compare roots and whole components, with POSIX and canonical Windows component case intact. */
function within(child: string, parent: string): boolean {
  const cRoot = path.parse(child).root
  const pRoot = path.parse(parent).root
  if (cRoot !== pRoot) return false
  const c = child.slice(cRoot.length).split(path.sep).filter(Boolean)
  const p = parent.slice(pRoot.length).split(path.sep).filter(Boolean)
  return p.length <= c.length && p.every((part, i) => part === c[i])
}
