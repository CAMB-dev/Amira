import { lstat, mkdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Validate each ancestor before creating children, and return the pinned real directory. This
 * refuses links planted at .assets or .assets/outputs; it is path-based, so replacing the
 * resolved directory between this check and file creation is not prevented (that needs native
 * handle-anchored file operations, which Amira does not use).
 */
export async function sessionOutputDir(dir: string, storageRoot: string): Promise<string> {
  // The trusted root must not be derived from a real path through .assets or outputs.
  const root = resolve(storageRoot)
  const target = resolve(dir)
  const escaped = () => new Error("output directory escapes session storage")
  if (!inside(root, target)) throw escaped()
  // New sessions are lazy: only the caller-trusted root may be created recursively.
  await mkdir(root, { recursive: true })
  const trusted = await realpath(root)
  let pinned = trusted
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    const next = join(pinned, part)
    try {
      // lstat distinguishes an absent component from a dangling symlink/junction.
      await lstat(next)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      try {
        // Never recursively create through an ancestor that has not been validated.
        await mkdir(next)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      }
    }
    pinned = await realpath(next)
    if (!inside(trusted, pinned)) throw escaped()
  }
  return pinned
}
