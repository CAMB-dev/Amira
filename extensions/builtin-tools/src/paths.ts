import { isAbsolute, relative, resolve } from "node:path"

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/** Forward-slash path relative to `cwd`, or the absolute path when it lies outside `cwd`. */
export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  const shown = rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? abs : rel
  return shown.replaceAll("\\", "/")
}
