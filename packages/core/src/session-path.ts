import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

/** One physical session target and lock namespace, including not-yet-published files. */
export function canonicalSessionFile(file: string): string {
  return resolve(file, new Set())
}

function resolve(file: string, seen: Set<string>): string {
  try {
    // Avoid a failed realpath walk for missing components. Existing targets must
    // use realpath itself: collapsing link/.. first can select a different file.
    lstatSync(file)
    const target = realpathSync(file)
    const stat = statSync(target)
    // Hard links have no unique filename to place a cross-process lease beside.
    // Refuse ownership instead of allowing two independent names to grant authority.
    if (stat.isFile() && stat.nlink > 1) throw new Error(`Hard-linked session files cannot be owned: ${file}`)
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  // Preserve the previous release's lexical namespace for dangling aliases. It
  // changes to realpath's namespace only once the requested target exists.
  const normalized = path.resolve(file)
  if (normalized !== file) return resolve(normalized, seen)
  if (seen.has(file)) throw new Error(`Cyclic session file alias: ${file}`)
  seen.add(file)
  try {
    if (lstatSync(file).isSymbolicLink()) {
      return resolve(path.resolve(path.dirname(file), readlinkSync(file)), seen)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const parent = path.dirname(file)
  if (parent === file) throw new Error(`Session file parent is unavailable: ${file}`)
  return path.join(resolve(parent, seen), path.basename(file))
}
