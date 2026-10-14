import { cp, lstat, mkdir, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { engineMismatch, readManifest } from "../../packages/packages/src/manifest.ts"

function within(parent: string, target: string): boolean {
  const relative = path.relative(parent, target)
  return (
    !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
}

/** Inspect paths only; never import opt-in code in the launcher or daemon. */
export async function extensionDirectory(directory: string): Promise<string> {
  const source = path.resolve(directory)
  const homes = [path.join(os.homedir(), ".amira"), process.env.AMIRA_HOME].filter(
    (home): home is string => !!home,
  )
  function rejectHome(target: string) {
    for (const home of homes) {
      if (within(path.resolve(home), target) || within(target, path.resolve(home))) {
        throw new Error(`UI walk refuses real Amira home paths: ${source}`)
      }
    }
  }
  rejectHome(source)
  rejectHome(await realpath(source))
  const info = await lstat(source)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`UI walk --extension requires a local directory, not a file or symlink: ${source}`)
  }
  await entryPoints(source)
  return source
}

async function entryPoints(directory: string): Promise<string[]> {
  const manifest = await Promise.all(
    ["amira-package.json", "package.json"].map((file) =>
      lstat(path.join(directory, file)).catch(() => undefined),
    ),
  )
  if (manifest.some((info) => info?.isSymbolicLink())) {
    throw new Error(`UI walk extension manifests must not be symlinks: ${directory}`)
  }
  let entries: string[]
  if (manifest.some(Boolean)) {
    const parsed = readManifest(directory)
    const mismatch = engineMismatch(parsed)
    if (mismatch) throw new Error(mismatch)
    entries = parsed.extensions
  } else {
    entries = []
    for (const file of ["index.ts", "src/index.ts"]) {
      const entry = path.join(directory, file)
      if ((await lstat(entry).catch(() => undefined))?.isFile()) {
        entries = [entry]
        break
      }
    }
  }
  if (!entries.length)
    throw new Error(`UI walk extension directory has no extension entry points: ${directory}`)
  for (const entry of entries) {
    if (!(await lstat(entry)).isFile()) throw new Error(`UI walk extension entry must be a file: ${entry}`)
  }
  return entries
}

/** Copy trusted test code, never install dependencies or load package commands/settings. */
export async function copyExtensions(home: string, directories: string[] = []): Promise<string[]> {
  const entries: string[] = []
  for (const [index, directory] of directories.entries()) {
    const source = await extensionDirectory(directory)
    const target = path.join(home, "extensions", `local-${index}`)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      async filter(file) {
        if (path.basename(file) === ".git") return false
        // link-amira's development links are not runtime dependencies: the host supplies its API.
        if (file === path.join(source, "node_modules", "@amira")) return false
        if ((await lstat(file)).isSymbolicLink()) {
          throw new Error(`UI walk extension copies do not allow symlinks: ${file}`)
        }
        return true
      },
    })
    entries.push(...(await entryPoints(target)))
  }
  return entries
}
