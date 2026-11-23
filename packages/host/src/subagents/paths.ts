import { realpathSync } from "node:fs"
import path from "node:path"

/** One directory contains the other (or they are the same), by real path. */
export function overlaps(a: string, b: string): boolean {
  const key = (p: string) => {
    let real = path.resolve(p)
    try {
      // A junction or link alias of the parent's directory is still the same files.
      real = realpathSync.native(real)
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real
  }
  const inside = (child: string, root: string) => {
    const rel = path.relative(key(root), key(child))
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  }
  return inside(a, b) || inside(b, a)
}
