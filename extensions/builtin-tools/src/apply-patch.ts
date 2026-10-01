import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { type ApplyPatchDetails, defineTool, textResult } from "@amira/api"
import { fileDiff } from "./diff.ts"
import { applyUpdate, parsePatch } from "./patch-format.ts"
import { displayPath, fileKey, resolvePath } from "./paths.ts"
import { decodeText, encodeText, looksBinary } from "./text.ts"

export interface ApplyPatchParams {
  patch: string
}

interface Snapshot {
  path: string
  bytes?: Buffer
  ino?: number
  dev?: number
  mode?: number
}

interface Change {
  before: Snapshot
  after?: Uint8Array
  mode?: number
}

/** The mutation boundary is injectable so tests can exercise partial I/O failures. */
export interface PatchIO {
  write(handle: FileHandle, bytes: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
  /** Keeps a deleted file's inode reachable for rollback; defaults to a hard link on disk. */
  link?(existing: string, backup: string): Promise<void>
}

const disk: PatchIO = {
  async write(handle, bytes) {
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (bytesWritten === 0) throw new Error("Write made no progress")
      offset += bytesWritten
    }
    await handle.truncate(bytes.length)
  },
  remove: unlink,
}

async function stat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function safePath(cwd: string, input: string): Promise<string> {
  if (!input || input.includes("\0")) throw new Error(`Invalid patch path: ${input}`)
  const abs = resolvePath(cwd, input)
  const rel = relative(cwd, abs)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${input}`)
  }
  if (process.platform === "win32") {
    for (const part of rel.split(sep)) {
      if (
        /[.: ]$/.test(part) ||
        part.includes(":") ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      ) {
        throw new Error(`Unsafe Windows path: ${input}`)
      }
    }
  }
  // No link (junctions are symbolic links on Windows) may sit between cwd and the file, or a
  // write would land elsewhere. The workspace itself may be reached through one; that is the
  // user's choice, and macOS temp dirs and Windows project dirs often are.
  let path = abs
  for (const _ of rel.split(sep)) {
    const st = await stat(path)
    if (st?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`)
    if (st && path !== abs && !st.isDirectory()) throw new Error(`Not a directory: ${path}`)
    path = dirname(path)
  }
  return abs
}

async function snapshot(path: string): Promise<Snapshot> {
  const st = await stat(path)
  if (!st) return { path }
  if (!st.isFile()) throw new Error(`Not a regular file: ${path}`)
  return { path, bytes: await readFile(path), ino: st.ino, dev: st.dev, mode: st.mode }
}

async function unchanged(cwd: string, before: Snapshot): Promise<void> {
  await safePath(cwd, before.path)
  const now = await snapshot(before.path)
  if (
    now.ino !== before.ino ||
    now.dev !== before.dev ||
    (now.bytes === undefined) !== (before.bytes === undefined) ||
    (now.bytes && !now.bytes.equals(before.bytes!))
  )
    throw new Error(`File changed while preparing patch: ${before.path}; read it again`)
}

function textOf(before: Snapshot): ReturnType<typeof decodeText> {
  if (!before.bytes) throw new Error(`File not found: ${before.path}`)
  const decoded = decodeText(before.bytes)
  if (
    looksBinary(before.bytes, decoded) ||
    decoded.invalid ||
    !before.bytes.equals(encodeText(decoded.text, decoded))
  ) {
    throw new Error(`Refusing binary or invalid text file: ${before.path}`)
  }
  return decoded
}

export async function applyPatch(
  cwd: string,
  patch: string,
  signal: AbortSignal,
  io: PatchIO = disk,
): Promise<ApplyPatchDetails> {
  signal.throwIfAborted()
  const operations = parsePatch(patch)
  const changes: Change[] = []
  const files: ApplyPatchDetails["files"] = []
  const originals = new Map<string, Snapshot>()
  const staged = new Map<string, Snapshot>()
  async function claim(input: string) {
    const path = await safePath(cwd, input)
    const key = fileKey(cwd, path)!
    const previous = staged.get(key)
    if (previous) return previous
    for (const other of originals.keys()) {
      if (key.startsWith(`${other}${sep}`) || other.startsWith(`${key}${sep}`)) {
        throw new Error(`Patch paths conflict as file and directory: ${input}`)
      }
    }
    const before = await snapshot(path)
    for (const other of originals.values()) {
      if (before.bytes && before.ino === other.ino && before.dev === other.dev) {
        throw new Error(
          `Patch targets multiple hard links to the same file: ${other.path}, ${input}; use one path`,
        )
      }
    }
    originals.set(key, before)
    staged.set(key, before)
    return before
  }
  function stage(change: Change) {
    changes.push(change)
    staged.set(
      fileKey(cwd, change.before.path)!,
      change.after
        ? { ...change.before, bytes: Buffer.from(change.after), mode: change.mode ?? change.before.mode }
        : { path: change.before.path },
    )
  }
  for (const op of operations) {
    const before = await claim(op.path)
    if (op.kind === "add") {
      if (before.bytes) throw new Error(`Cannot add existing file: ${op.path}`)
      stage({ before, after: Buffer.from(op.content) })
      files.push({ path: before.path, action: "add", ...fileDiff("", op.content) })
    } else {
      if (op.kind === "delete") {
        if (!before.bytes) throw new Error(`File not found: ${before.path}`)
        const decoded = decodeText(before.bytes)
        stage({ before })
        files.push({
          path: before.path,
          action: "delete",
          ...(looksBinary(before.bytes, decoded) || decoded.invalid
            ? { hunks: [], added: 0, removed: 0, truncated: true }
            : fileDiff(decoded.text, "")),
        })
      } else {
        const decoded = textOf(before)
        const updated = applyUpdate(decoded.text, op)
        const after = encodeText(updated, decoded)
        if (op.moveTo) {
          const destination = await claim(op.moveTo)
          if (destination.bytes) throw new Error(`Move destination already exists: ${op.moveTo}`)
          stage({ before: destination, after, mode: before.mode })
          stage({ before })
          files.push({
            path: destination.path,
            from: before.path,
            action: "move",
            ...fileDiff(decoded.text, updated),
          })
        } else {
          stage({ before, after })
          files.push({ path: before.path, action: "update", ...fileDiff(decoded.text, updated) })
        }
      }
    }
  }
  // Validate every source and destination before any directory or file is created.
  for (const before of originals.values()) await unchanged(cwd, before)
  signal.throwIfAborted()
  const currentState = new Map(originals)
  const journal: (Change & { owned: Snapshot; backup?: string })[] = []
  const backups: string[] = []
  const directories: string[] = []
  async function cleanBackups(): Promise<string[]> {
    const failures: string[] = []
    for (const dir of backups.toReversed()) {
      try {
        await unlink(join(dir, "original")).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
        await rmdir(dir)
      } catch (error) {
        failures.push(`${dir}: ${(error as Error).message}`)
      }
    }
    return failures
  }
  try {
    for (const planned of changes) {
      signal.throwIfAborted()
      const key = fileKey(cwd, planned.before.path)!
      const change = { ...planned, before: currentState.get(key)! }
      await unchanged(cwd, change.before)
      if (change.after) {
        const missing: string[] = []
        for (let dir = dirname(change.before.path); !(await stat(dir)); dir = dirname(dir)) missing.push(dir)
        for (const dir of missing.reverse()) {
          await mkdir(dir)
          directories.push(dir)
        }
      }
      if (change.after) {
        // Journal only after exclusive creation succeeds: EEXIST belongs to somebody else.
        const handle = await open(change.before.path, change.before.bytes ? "r+" : "wx", change.mode)
        try {
          const st = await handle.stat()
          if (
            change.before.bytes &&
            (st.ino !== change.before.ino ||
              st.dev !== change.before.dev ||
              !(await handle.readFile()).equals(change.before.bytes))
          ) {
            throw new Error(`File changed before writing: ${change.before.path}`)
          }
          journal.push({ ...change, owned: { path: change.before.path, ino: st.ino, dev: st.dev } })
          await io.write(handle, change.after)
          currentState.set(key, {
            ...change.before,
            bytes: Buffer.from(change.after),
            ino: st.ino,
            dev: st.dev,
            mode: st.mode,
          })
        } finally {
          await handle.close()
        }
      } else {
        // Keep the inode alive so rollback can restore the name and all hard-link relationships.
        let backup: string | undefined
        try {
          const directory = await mkdtemp(join(dirname(change.before.path), ".amira-patch-"))
          backups.push(directory)
          await (io.link ?? link)(change.before.path, join(directory, "original"))
          backup = join(directory, "original")
        } catch {
          // No hard links here (FAT, exFAT, some network shares): rollback rewrites the saved bytes.
        }
        journal.push({ ...change, owned: change.before, backup })
        await io.remove(change.before.path)
        currentState.set(key, { path: change.before.path })
      }
    }
  } catch (error) {
    const failures: string[] = []
    for (const { before, after, owned, backup } of journal.reverse()) {
      try {
        await safePath(cwd, before.path)
        const current = await stat(before.path)
        if (current && (current.ino !== owned.ino || current.dev !== owned.dev)) {
          throw new Error("Path was replaced concurrently; refusing to overwrite it")
        }
        if (!current && after && before.bytes)
          throw new Error("Path was removed concurrently; refusing to recreate it")
        if (!current && backup) await link(backup, before.path)
        // writeFile truncates the existing inode; every hard link sees the restored bytes.
        if (before.bytes) await writeFile(before.path, before.bytes, { mode: before.mode })
        else if (current) await unlink(before.path)
      } catch (rollbackError) {
        failures.push(`${before.path}: ${(rollbackError as Error).message}`)
      }
    }
    failures.push(...(await cleanBackups()))
    for (const dir of directories.reverse()) {
      try {
        await rmdir(dir)
      } catch (rollbackError) {
        failures.push(`${dir}: ${(rollbackError as Error).message}`)
      }
    }
    throw new Error(
      `${(error as Error).message}\n${failures.length ? `Rollback incomplete: ${failures.join("; ")}` : "All patch changes rolled back."}`,
    )
  }
  const cleanupFailures = await cleanBackups()
  if (cleanupFailures.length)
    throw new Error(`Patch applied, but temporary backup cleanup failed: ${cleanupFailures.join("; ")}`)
  return { files }
}

export const applyPatchTool = defineTool<ApplyPatchParams>({
  name: "apply_patch",
  description: [
    "Apply a Codex patch to workspace files. Read existing files first.",
    "Use *** Begin Patch, *** Add File: path (each content line starts with +), *** Delete File: path, or *** Update File: path with @@ hunks; end with *** End Patch.",
    "Update lines start with a space for context, - for removals, or + for additions. @@ context locates a section; *** End of File anchors the final hunk. *** Move to: path follows an Update File header.",
    "Blocks run in order against earlier results; all hunks are validated before writing and I/O failures trigger rollback. Paths must remain in the workspace, without symbolic links. Add/move destinations must be absent at that point. Use only one path per hard-linked file; updates write in place and affect every link.",
    "Existing encoding, BOM, line endings and final-newline state are preserved. Errors include unmatched context and the closest candidate.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The complete *** Begin Patch / *** End Patch envelope" },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  concurrency: "serial",
  async execute({ patch }, ctx) {
    if (typeof patch !== "string") return textResult("patch must be a string", true)
    try {
      const details = await applyPatch(ctx.cwd, patch, ctx.signal)
      return {
        ...textResult(
          details.files.length
            ? `Applied patch:\n${details.files.map((file) => `${file.action}: ${file.from ? `${displayPath(ctx.cwd, file.from)} -> ` : ""}${displayPath(ctx.cwd, file.path)}`).join("\n")}`
            : "No files changed.",
        ),
        details,
      }
    } catch (error) {
      return textResult((error as Error).message, true)
    }
  },
})
