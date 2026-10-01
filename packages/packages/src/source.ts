import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PackageSource } from "./lock.ts"

/** What `amira ext install <spec>` asked for: a concrete source, or a name to look up in the index. */
export type InstallSpec = PackageSource | { type: "name"; name: string }

const GIT = /^(git\+|git:\/\/|ssh:\/\/|git@|file:\/\/|https?:\/\/)/
const LOCAL = /^(\.{1,2}([\\/]|$)|[\\/]|~([\\/]|$)|[A-Za-z]:[\\/])/

/**
 * Reads an install spec:
 * - a path (`./x`, `../x`, `/x`, `C:\x`, `~/x`, or any existing directory);
 * - a git URL (`https://`, `git+https://`, `ssh://`, `git@host:`, `file://`), with `#ref`;
 * - an npm spec (`npm:name[@range]`, or a scoped or versioned name like `@s/x` or `x@1`);
 * - otherwise a name from the extensions index.
 */
export function parseSpec(spec: string, cwd: string, home = os.homedir()): InstallSpec {
  if (spec.startsWith("npm:")) return { type: "npm", spec: spec.slice(4) }
  if (GIT.test(spec)) {
    const hash = spec.indexOf("#")
    const url = (hash < 0 ? spec : spec.slice(0, hash)).replace(/^git\+/, "")
    const ref = hash < 0 ? "" : spec.slice(hash + 1)
    return { type: "git", url, ...(ref ? { ref } : {}) }
  }
  if (LOCAL.test(spec)) return { type: "path", path: path.resolve(cwd, spec.replace(/^~(?=$|[\\/])/, home)) }
  if (existsSync(path.resolve(cwd, spec))) return { type: "path", path: path.resolve(cwd, spec) }
  if (spec.startsWith("@") || spec.includes("@")) return { type: "npm", spec }
  return { type: "name", name: spec }
}

/** `@scope/name@range` → name and range; no range means the `latest` tag. */
export function splitNpmSpec(spec: string): { name: string; range: string } {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0)
  if (at < 0) return { name: spec, range: "latest" }
  return { name: spec.slice(0, at), range: spec.slice(at + 1) || "latest" }
}
