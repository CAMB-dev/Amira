import { lstatSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { type ProtectOptions, toolPath } from "./protected.ts"

/** Normalizing link/.. can hide native traversal outside the reported directory. */
export function safeParents(cwd: string, input: string, opts: ProtectOptions): boolean {
  const parents = process.platform === "win32" ? /(^|[\\/])\.\.(?=$|[\\/])/g : /(^|\/)\.\.(?=$|\/)/g
  for (const match of input.matchAll(parents)) {
    const prefix = input.slice(0, match.index + match[1]!.length)
    // Remove trailing separators through toolPath so lstat inspects the link itself.
    const entry = lstatSync(toolPath(cwd, prefix || ".", opts))
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false
  }
  return true
}

/** Only ENOENT on a genuinely absent entry permits appending a nonexistent suffix. */
export function existingPrefix(abs: string, directory = false): string | undefined {
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
export function safeName(input: string, absolute: boolean): string | undefined {
  if (!input) return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid path reports
  if (!input.isWellFormed() || /[\x00-\x1f\x7f]/.test(input)) return undefined
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
      if (/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(segment))
        return undefined
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
export function within(child: string, parent: string): boolean {
  const cRoot = path.parse(child).root
  const pRoot = path.parse(parent).root
  if (cRoot !== pRoot) return false
  const c = child.slice(cRoot.length).split(path.sep).filter(Boolean)
  const p = parent.slice(pRoot.length).split(path.sep).filter(Boolean)
  return p.length <= c.length && p.every((part, i) => part === c[i])
}
