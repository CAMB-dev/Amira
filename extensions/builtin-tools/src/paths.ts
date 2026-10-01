import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

export const OUTSIDE_WORKING_DIRECTORY = "[outside working directory]"

export function resolvePath(cwd: string, path: string): string {
  const p = expandPath(path)
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

/** Expands `~`, and on Windows the MSYS forms Git Bash prints: `/c/...` and `/tmp/...`. */
function expandPath(path: string): string {
  const home = path.match(/^~(?=$|[/\\])(.*)$/s)
  if (home) return join(homedir(), home[1]!)
  if (process.platform !== "win32") return path
  const tmp = path.match(/^\/tmp(?=$|\/)(.*)$/s)
  if (tmp) return join(tmpdir(), tmp[1]!)
  const drive = path.match(/^\/([a-zA-Z])(?:$|\/)(.*)$/s)
  if (drive) return `${drive[1]!.toUpperCase()}:\\${drive[2]!}`
  return path
}

/** Forward-slash path relative to `cwd`; an absolute path outside it is explicitly marked. */
export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  const outside = rel.startsWith("..") || isAbsolute(rel)
  const shown = rel === "" ? "." : outside ? `${OUTSIDE_WORKING_DIRECTORY} ${abs}` : rel
  return shown.replaceAll("\\", "/")
}

/** Key for ordering writes to the same file: the resolved path, case-folded where paths are case-insensitive. */
export function fileKey(cwd: string, path: unknown): string | undefined {
  if (typeof path !== "string" || path === "") return undefined
  const abs = resolvePath(cwd, path)
  return process.platform === "win32" || process.platform === "darwin" ? abs.toLowerCase() : abs
}
