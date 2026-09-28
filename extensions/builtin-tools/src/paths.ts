import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

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

/** Forward-slash path relative to `cwd`, or the absolute path when it lies outside `cwd`. */
export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  const shown = rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? abs : rel
  return shown.replaceAll("\\", "/")
}
