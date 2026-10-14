import { lstatSync, readlinkSync, realpathSync, type Stats, statSync } from "node:fs"
import path from "node:path"

/** One physical session target and lock namespace, including not-yet-published files. */
export function canonicalSessionFile(file: string): string {
  return resolve(file, new Set())
}

function resolve(file: string, seen: Set<string>): string {
  let entry: Stats | undefined
  try {
    // Avoid a failed realpath walk for missing components. Existing targets must
    // use realpath itself: collapsing link/.. first can select a different file.
    entry = lstatSync(file)
    const target = realpathSync(file)
    const stat = statSync(target)
    // Hard links have no unique filename to place a cross-process lease beside.
    // Refuse ownership instead of allowing two independent names to grant authority.
    if (stat.isFile() && stat.nlink > 1) throw new Error(`Hard-linked session files cannot be owned: ${file}`)
    return target
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }
  // ENOTDIR also means an unpublished target: a blocking ancestor can be repaired
  // before the first write. Ownership still requires creating the filesystem gate.
  // Preserve the previous release's lexical namespace for dangling aliases. It
  // changes to realpath's namespace only once the requested target exists.
  const normalized = path.resolve(file)
  if (normalized !== file) return resolve(normalized, seen)
  if (seen.has(file)) throw new Error(`Cyclic session file alias: ${file}`)
  seen.add(file)
  try {
    if (entry?.isSymbolicLink()) {
      return resolve(path.resolve(path.dirname(file), readlinkSync(file)), seen)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }
  const parent = path.dirname(file)
  if (parent === file) throw new Error(`Session file parent is unavailable: ${file}`)
  try {
    // The parent names no recording to own. Resolve its physical namespace directly;
    // mkdir and the filesystem gate still validate it before any write authority.
    return path.join(realpathSync(parent), path.basename(file))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }
  return path.join(resolve(parent, seen), path.basename(file))
}
