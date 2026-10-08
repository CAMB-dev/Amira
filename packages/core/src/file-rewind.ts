import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import type { FileMutation, FileRewindPlan, MutateFiles, Settings } from "@amira/api"
import {
  DEFAULT_FILE_REWIND_ENABLED,
  DEFAULT_FILE_REWIND_MAX_FILE_BYTES,
  DEFAULT_FILE_REWIND_QUOTA_BYTES,
} from "@amira/api"
import { toolPath } from "./permissions/protected.ts"
import type { SessionEntry, SessionStore } from "./session-store.ts"

interface FileImage {
  /** The file's real path when captured: links, case and 8.3 aliases resolved. */
  path: string
  before: string | null
  after: string | null
  mode?: number
}

/** The inode an in-place restore was writing when it was interrupted. */
interface InPlace {
  ino: string
  dev: string
}

export type FileJournalEntry =
  | {
      type: "file_mutation"
      messageId: string
      sessionId: string
      toolCallId: string
      turnId: string
      files: FileImage[]
    }
  | { type: "file_mutation_end"; mutationId: string; rolledBack: boolean; files?: FileImage[] }
  | { type: "file_restore"; messageId: string; target: string | null; files: FileImage[] }
  /** `started` precedes an in-place write (hard-linked files), which is not atomic. */
  | { type: "file_restore_progress"; restoreId: string; path: string; started?: InPlace }
  | { type: "file_restore_end"; restoreId: string; abandoned?: boolean }
  | { type: "file_prune" }

type Mutation = Extract<SessionEntry, { type: "file_mutation" }>
type Restore = Extract<SessionEntry, { type: "file_restore" }>

export const FILE_REWIND_COVERAGE =
  "Built-in and declared file-tool changes are covered, including same-directory sub-agents. Shell commands, hook formatters, other processes, user edits and separate worktrees are not captured."

export class FileRewindConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(`File restore refused; nothing changed. Conflicts:\n${conflicts.join("\n")}`)
  }
}

/** Session-local byte images and a write-ahead journal. One recorder is shared by same-dir agents. */
export class FileRewind {
  readonly directory: string
  readonly enabled: boolean
  readonly maxFileBytes: number
  readonly quotaBytes: number
  #tail: Promise<void> = Promise.resolve()
  #active = 0
  /** Why the pending restore last failed in this process, when not for a conflict (e.g. EPERM). */
  #failure: string | undefined

  constructor(
    readonly store: SessionStore,
    settings: Settings["fileRewind"] = {},
  ) {
    this.directory = fileHistoryDir(store.file)
    this.enabled = (settings.enabled ?? DEFAULT_FILE_REWIND_ENABLED) !== false
    this.maxFileBytes = settings.maxFileBytes ?? DEFAULT_FILE_REWIND_MAX_FILE_BYTES
    this.quotaBytes = settings.quotaBytes ?? DEFAULT_FILE_REWIND_QUOTA_BYTES
  }

  get busy(): boolean {
    return this.#active > 0
  }

  get restoring(): boolean {
    return this.#pending() !== undefined
  }

  /** The unfinished restore and what blocks finishing it, if any. */
  interrupted(): { messageId: string; conflicts: string[]; failure?: string } | undefined {
    const pending = this.#pending()
    if (!pending) return undefined
    const conflicts = this.#checkRestore(pending).conflicts
    return { messageId: pending.messageId, conflicts, ...(this.#failure ? { failure: this.#failure } : {}) }
  }

  async mutate(
    changes: FileMutation[],
    write: () => Promise<void>,
    source: { sessionId: string; toolCallId: string; turnId: string },
  ): Promise<void> {
    return this.#mutate(changes, () => write(), source, false)
  }

  /** Captures a third-party writer's pre-images and records its post-images after it returns. */
  async mutatePaths(
    paths: readonly string[],
    cwd: string,
    write: (mutateFiles: MutateFiles) => Promise<void>,
    source: { sessionId: string; toolCallId: string; turnId: string },
  ): Promise<void> {
    return this.#mutate(
      paths.map((p) => ({ path: toolPath(cwd, p) })),
      (mutateFiles) => write(mutateFiles!),
      source,
      true,
    )
  }

  async #mutate(
    changes: { path: string; before?: Uint8Array | null; after?: Uint8Array | null }[],
    write: (mutateFiles?: MutateFiles) => Promise<void>,
    source: { sessionId: string; toolCallId: string; turnId: string },
    captureAfter: boolean,
  ): Promise<void> {
    this.#active++
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      if (this.#pending())
        throw new Error(
          "An interrupted file restore must finish before file tools can write; rewind to the same message again, or rewind the conversation only to abandon it if it has conflicts",
        )
      if (!this.enabled) return await write()
      const message = this.store.branch().findLast((e) => e.type === "message" && e.message.role === "user")
      if (!message) throw new Error("Cannot capture file changes without a stored user message")
      const files: FileImage[] = []
      const seen = new Set<string>()
      try {
        for (const change of changes) {
          // A relative path would resolve against the process, not the tool's directory.
          if (!path.isAbsolute(change.path)) throw new Error(`Not an absolute path: ${change.path}`)
          const file = canonicalPath(change.path)
          if (seen.has(pathKey(file))) throw new Error(`Duplicate mutation path: ${file}`)
          seen.add(pathKey(file))
          const before = readImage(file, this.maxFileBytes)
          if (change.before !== undefined && hash(change.before) !== hash(before.bytes)) {
            throw new Error(`File changed before writing: ${file}; read it again`)
          }
          const after = change.after === undefined ? before.bytes : change.after
          files.push({
            path: file,
            before: this.#put(before.bytes),
            after: this.#put(after),
            ...(before.mode === undefined ? {} : { mode: before.mode }),
          })
        }
      } catch (error) {
        throw new Error(`File rewind capture failed; write refused: ${(error as Error).message}`)
      }
      // Failure here must propagate, unlike best-effort conversation persistence.
      const id = this.store.appendDurable({ type: "file_mutation", messageId: message.id, ...source, files })
      try {
        const nested = captureAfter
          ? ((async (nestedChanges: FileMutation[], nestedWrite: () => Promise<void>) => {
              for (const change of nestedChanges) {
                if (!path.isAbsolute(change.path) || !seen.has(pathKey(canonicalPath(change.path)))) {
                  throw new Error(`Mutation path was not declared: ${change.path}`)
                }
                // The same stale-read guard the hook gives a tool that captures its own writes.
                if (change.before !== undefined) {
                  const now = readImage(canonicalPath(change.path), this.maxFileBytes)
                  if (hash(change.before) !== hash(now.bytes)) {
                    throw new Error(`File changed before writing: ${change.path}; read it again`)
                  }
                }
              }
              return nestedWrite()
            }) satisfies MutateFiles)
          : undefined
        await write(nested)
      } catch (error) {
        // A patch owns its rollback. A torn/partial write remains pending and conflicts on rewind.
        if (files.every((f) => currentHash(f.path) === f.before)) {
          try {
            this.store.appendDurable({ type: "file_mutation_end", mutationId: id, rolledBack: true })
          } catch {
            // Unended, the mutation is read as "written or not" per file: still correct.
          }
        }
        throw error
      }
      try {
        const completed = captureAfter
          ? files.map((file) => {
              const after = readImage(file.path, this.maxFileBytes)
              return { ...file, after: this.#put(after.bytes) }
            })
          : undefined
        this.store.appendDurable({
          type: "file_mutation_end",
          mutationId: id,
          rolledBack: false,
          ...(completed ? { files: completed } : {}),
        })
      } catch {
        // The write happened; reporting it as failed would invite a redo. Unended is still correct.
      }
    } finally {
      this.#active--
      release()
    }
  }

  plan(messageId: string): FileRewindPlan {
    const pending = this.#pending()
    if (pending && pending.messageId !== messageId) {
      const conflicts = this.#checkRestore(pending).conflicts
      return {
        owner: "core",
        enabled: false,
        restored: 0,
        removed: 0,
        conflicts,
        note: `An interrupted file restore to before an earlier choice must finish first: pick that message again${conflicts.length || this.#failure ? `, or, since it ${conflicts.length ? "has conflicts" : `failed (${this.#failure})`}, rewind the conversation only to abandon it` : ""}. ${FILE_REWIND_COVERAGE}`,
      }
    }
    const { files, conflicts, pruned } = pending
      ? { files: pending.files, conflicts: this.#checkRestore(pending).conflicts, pruned: false }
      : this.#plan(messageId)
    return {
      owner: "core",
      enabled: pending !== undefined || (this.enabled && !pruned),
      restored: files.filter((f) => f.before !== null).length,
      removed: files.filter((f) => f.before === null).length,
      conflicts,
      note: `${pending ? `Resume the interrupted file restore${this.#failure ? ` (last attempt failed: ${this.#failure})` : ""}${conflicts.length || this.#failure ? "; conversation-only rewind abandons it" : ""}. ` : !this.enabled ? "Capture is disabled; files will not be restored. " : pruned ? "File history was pruned; files will not be restored. " : ""}${FILE_REWIND_COVERAGE}`,
    }
  }

  /** Restores files and checks out the conversation as one resumable operation. */
  restore(messageId: string, target: string | null): void {
    this.#idle()
    this.#failure = undefined
    const pending = this.#pending()
    if (pending) {
      if (pending.messageId !== messageId) throw new Error("Resume the interrupted rewind first")
      this.#apply(pending)
      return
    }
    const plan = this.#plan(messageId)
    if (plan.pruned) throw new Error("File history was pruned; use conversation-only rewind")
    if (plan.conflicts.length) throw new FileRewindConflictError(plan.conflicts)
    const id = this.store.appendDurable({ type: "file_restore", messageId, target, files: plan.files })
    this.#apply(this.store.get(id) as Restore)
  }

  /** Continues a previously authorized restore on session resume, even if capture is now off. */
  recover(): { restored: number; removed: number } | undefined {
    this.#idle()
    const pending = this.#pending()
    if (!pending) return undefined
    this.#failure = undefined
    this.#apply(pending)
    return {
      restored: pending.files.filter((f) => f.before !== null).length,
      removed: pending.files.filter((f) => f.before === null).length,
    }
  }

  /**
   * Gives up an interrupted restore that conflicts, or an I/O error in its last attempt here
   * (a read-only or locked file, say), keep from finishing. Files stay as they are, some restored
   * and some not; the caller then rewinds the conversation only.
   */
  abandon(): void {
    this.#idle()
    const pending = this.#pending()
    if (!pending) return
    const { conflicts } = this.#checkRestore(pending)
    if (!conflicts.length && !this.#failure)
      throw new Error("The interrupted file restore can still finish; finish it instead")
    this.store.appendDurable({ type: "file_restore_end", restoreId: pending.id, abandoned: true })
    this.#failure = undefined
  }

  prune(): { files: number; bytes: number } {
    this.#idle()
    if (this.#pending()) throw new Error("Finish the interrupted file restore before pruning")
    const blobs = this.#blobs()
    this.store.appendDurable({ type: "file_prune" })
    for (const blob of blobs) unlinkSync(path.join(this.directory, blob.name))
    return { files: blobs.length, bytes: blobs.reduce((n, b) => n + b.size, 0) }
  }

  #idle() {
    if (this.busy) throw new Error("File tools are still running; wait for them before rewinding or pruning")
  }

  #pending(): Restore | undefined {
    const ended = new Set(
      this.store.entries.flatMap((e) => (e.type === "file_restore_end" ? [e.restoreId] : [])),
    )
    return this.store.entries.findLast((e): e is Restore => e.type === "file_restore" && !ended.has(e.id))
  }

  #plan(messageId: string): { files: FileImage[]; conflicts: string[]; pruned: boolean } {
    const branch = this.store.branch()
    const boundary = branch.findIndex((e) => e.id === messageId)
    if (boundary < 0) throw new Error("That message is not on the current session branch")
    const rollback = new Set(
      this.store.entries.flatMap((e) =>
        e.type === "file_mutation_end" && e.rolledBack ? [e.mutationId] : [],
      ),
    )
    const committed = new Set(
      this.store.entries.flatMap((e) => (e.type === "file_mutation_end" ? [e.mutationId] : [])),
    )
    const completed = new Map<string, FileImage[]>()
    for (const e of this.store.entries) {
      if (e.type === "file_mutation_end" && e.files) completed.set(e.mutationId, e.files)
    }
    const mutations = branch
      .slice(boundary)
      .filter((e): e is Mutation => e.type === "file_mutation" && !rollback.has(e.id))
    const pruneAt = this.store.entries.findLastIndex((e) => e.type === "file_prune")
    if (mutations.some((e) => this.store.entries.indexOf(e) < pruneAt)) {
      return { files: [], conflicts: [], pruned: true }
    }
    // `unwritten` is the other possible state of a file a crashed, uncommitted tool may have
    // written or not: either is accepted, by the next captured write or by the file on disk.
    const files = new Map<string, FileImage & { unwritten?: string | null }>()
    const conflicts = new Set<string>()
    for (const mutation of mutations) {
      for (const image of completed.get(mutation.id) ?? mutation.files) {
        const key = pathKey(image.path)
        const earlier = files.get(key)
        if (earlier && earlier.after !== image.before && earlier.unwritten !== image.before)
          conflicts.add(image.path)
        files.set(key, {
          ...image,
          before: earlier ? earlier.before : image.before,
          mode: earlier ? earlier.mode : image.mode,
          ...(committed.has(mutation.id) ? {} : { unwritten: image.before }),
        })
      }
    }
    const planned: FileImage[] = []
    for (const { unwritten, ...file } of files.values()) {
      const current = currentHash(file.path)
      if (unwritten !== undefined && current === unwritten) file.after = unwritten
      if (current !== file.after) conflicts.add(file.path)
      try {
        if (file.before !== null) this.#blob(file.before)
      } catch {
        conflicts.add(`${file.path} (missing or damaged pre-image)`)
      }
      planned.push(file)
    }
    return { files: planned, conflicts: [...conflicts], pruned: false }
  }

  #checkRestore(restore: Restore) {
    const progress = new Set<string>()
    const started = new Map<string, InPlace>()
    for (const e of this.store.entries) {
      if (e.type !== "file_restore_progress" || e.restoreId !== restore.id) continue
      if (e.started) started.set(e.path, e.started)
      else progress.add(e.path)
    }
    const conflicts: string[] = []
    const images = new Map<string, Buffer>()
    const torn = new Set<string>()
    // Validate the entire operation, including already completed files, before resuming it.
    for (const file of restore.files) {
      let before: Buffer | undefined
      try {
        if (file.before !== null) {
          before = this.#blob(file.before)
          images.set(file.path, before)
        }
      } catch {
        conflicts.push(`${file.path} (missing or damaged pre-image)`)
      }
      if (!progress.has(file.path) && before && this.#tornByUs(file, before, started.get(file.path)))
        torn.add(file.path)
      const current = currentHash(file.path)
      if (
        current !== file.before &&
        !torn.has(file.path) &&
        (progress.has(file.path) || current !== file.after)
      )
        conflicts.push(file.path)
    }
    return { progress, torn, conflicts, images }
  }

  /**
   * An interrupted in-place write leaves the same inode holding the pre-image's first k bytes and
   * the post-image from there on. Anything else, such as an edit made since, is not ours.
   */
  #tornByUs(file: FileImage, before: Buffer, at: InPlace | undefined): boolean {
    if (!at || !sameInode(file.path, at) || file.after === null) return false
    try {
      return intermediate(readFileSync(file.path), before, this.#blob(file.after))
    } catch {
      return false
    }
  }

  #apply(restore: Restore) {
    try {
      this.#applyChecked(restore)
    } catch (error) {
      if (!(error instanceof FileRewindConflictError)) this.#failure = (error as Error).message
      throw error
    }
  }

  #applyChecked(restore: Restore) {
    const { progress, torn, conflicts, images } = this.#checkRestore(restore)
    if (conflicts.length) {
      // Nothing of this restore has happened yet (a change slipped in after planning): end it,
      // so "nothing changed" is true and nothing stays pending.
      const begun = this.store.entries.some(
        (e) => e.type === "file_restore_progress" && e.restoreId === restore.id,
      )
      if (!begun)
        this.store.appendDurable({ type: "file_restore_end", restoreId: restore.id, abandoned: true })
      throw new FileRewindConflictError(conflicts)
    }
    for (const file of restore.files) {
      if (progress.has(file.path)) continue
      const current = currentHash(file.path)
      if (current !== file.before) {
        if (current !== file.after && !torn.has(file.path))
          throw new Error(
            `File changed during restore: ${file.path}; resolve it and resume the interrupted restore`,
          )
        if (file.before === null) unlinkSync(file.path)
        else {
          const st = statOrUndefined(file.path)
          if (st && st.nlink > 1n) {
            // A rename would detach this name from its other hard links: write the inode in place.
            writeInPlace(file.path, images.get(file.path)!, () =>
              this.store.appendDurable({
                type: "file_restore_progress",
                restoreId: restore.id,
                path: file.path,
                started: { ino: String(st.ino), dev: String(st.dev) },
              }),
            )
          } else {
            mkdirSync(path.dirname(file.path), { recursive: true })
            atomicWrite(file.path, images.get(file.path)!, file.mode)
          }
        }
      }
      this.store.appendDurable({ type: "file_restore_progress", restoreId: restore.id, path: file.path })
    }
    // The end marker follows checkout: a crash in either gap can replay the checkout safely.
    this.store.appendDurable({ type: "checkout", target: restore.target })
    this.store.appendDurable({ type: "file_restore_end", restoreId: restore.id })
  }

  #blobs(): { name: string; size: number }[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory).map((name) => ({
      name,
      size: statSync(path.join(this.directory, name)).size,
    }))
  }

  #put(bytes: Uint8Array | null): string | null {
    if (bytes === null) return null
    if (bytes.length > this.maxFileBytes)
      throw new Error(`Image exceeds fileRewind.maxFileBytes (${this.maxFileBytes} bytes)`)
    const key = hash(bytes)!
    const file = path.join(this.directory, key)
    if (existsSync(file)) {
      try {
        this.#blob(key)
        return key
      } catch {
        // A damaged image is replaced below with the bytes it should hold.
      }
    }
    if (this.#blobs().reduce((n, b) => n + b.size, 0) + bytes.length > this.quotaBytes) {
      throw new Error(
        `Session file rewind quota exceeded (${this.quotaBytes} bytes); explicitly prune history or raise fileRewind.quotaBytes`,
      )
    }
    mkdirSync(this.directory, { recursive: true })
    atomicWrite(file, bytes)
    return key
  }

  #blob(key: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid file image hash")
    const bytes = readFileSync(path.join(this.directory, key))
    if (hash(bytes) !== key) throw new Error(`Damaged file image ${key}`)
    return bytes
  }
}

/** Captured file bytes live with the session's other assets, `<session>.assets/files`. */
export function fileHistoryDir(sessionFile: string): string {
  return path.join(path.dirname(sessionFile), `${path.basename(sessionFile, ".jsonl")}.assets`, "files")
}

/**
 * Gives a forked session the images its copied journal refers to. Images never change once
 * written, so a hard link is as good as a copy, and deleting either session keeps the other's.
 */
export function copyFileHistory(from: SessionStore, to: SessionStore): void {
  const source = fileHistoryDir(from.file)
  const target = fileHistoryDir(to.file)
  const keys = new Set<string>()
  for (const e of to.entries) {
    if (e.type === "file_mutation" || e.type === "file_restore" || e.type === "file_mutation_end") {
      for (const f of e.files ?? []) for (const k of [f.before, f.after]) if (k) keys.add(k)
    }
  }
  for (const key of keys) {
    if (!/^[a-f0-9]{64}$/.test(key) || !existsSync(path.join(source, key))) continue
    mkdirSync(target, { recursive: true })
    if (existsSync(path.join(target, key))) continue
    try {
      linkSync(path.join(source, key), path.join(target, key))
    } catch {
      copyFileSync(path.join(source, key), path.join(target, key))
    }
  }
}

function hash(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex")
}

/** Case-insensitive file systems: Windows, and macOS by default. Merging is the safe mistake. */
function pathKey(file: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? file.toLowerCase() : file
}

/**
 * Where a path really leads: symbolic links, junctions, case, 8.3 names and mapped drives
 * resolved, so every alias of a file has one journal path. A missing tail is kept as given.
 */
function canonicalPath(file: string): string {
  const missing: string[] = []
  for (let at = path.resolve(file); ; ) {
    let real: string | undefined
    try {
      real = realpathSync.native(at)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") real = realpathSync(at)
    }
    if (real !== undefined) return path.join(real, ...missing.reverse())
    // A writer follows a dangling link to a target restore would never look at.
    if (lstatOrUndefined(at)?.isSymbolicLink()) throw new Error(`Dangling symbolic link: ${at}`)
    const parent = path.dirname(at)
    if (parent === at) return path.join(at, ...missing.reverse())
    missing.push(path.basename(at))
    at = parent
  }
}

function lstatOrUndefined(file: string) {
  try {
    return lstatSync(file)
  } catch {
    return undefined
  }
}

function statOrUndefined(file: string) {
  try {
    return lstatSync(file, { bigint: true })
  } catch {
    return undefined
  }
}

/** A regular file's bytes and mode, or null bytes when nothing is there. */
function readImage(file: string, limit = Number.POSITIVE_INFINITY): { bytes: Buffer | null; mode?: number } {
  const st = lstatOrUndefined(file)
  if (!st) return { bytes: null }
  if (!st.isFile()) throw new Error(`Not a regular file: ${file}`)
  if (st.size > limit) throw new Error(`${file} exceeds fileRewind.maxFileBytes (${limit} bytes)`)
  const bytes = readFileSync(file)
  if (bytes.length > limit) throw new Error(`${file} exceeds fileRewind.maxFileBytes (${limit} bytes)`)
  return { bytes, mode: st.mode }
}

/**
 * undefined (never equal to an image) when the file is unreadable or the journal path no longer
 * resolves to itself, e.g. a directory on it became a link: restore would land elsewhere.
 */
function currentHash(file: string): string | null | undefined {
  try {
    if (pathKey(canonicalPath(file)) !== pathKey(file)) return undefined
    return hash(readImage(file).bytes)
  } catch {
    return undefined
  }
}

function sameInode(file: string, at: InPlace | undefined): boolean {
  if (!at) return false
  const st = statOrUndefined(file)
  return !!st && st.isFile() && String(st.ino) === at.ino && String(st.dev) === at.dev
}

/** `opened` runs once the file is open for writing, before its first byte changes. */
function writeInPlace(file: string, bytes: Uint8Array, opened: () => void) {
  const fd = openSync(file, "r+")
  try {
    opened()
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset)
      if (written === 0) throw new Error(`Write made no progress: ${file}`)
      offset += written
    }
    ftruncateSync(fd, bytes.length)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function atomicWrite(file: string, bytes: Uint8Array, mode?: number) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    const fd = openSync(temporary, "wx", mode ?? 0o600)
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(temporary, file)
    } catch (error) {
      // Windows refuses to replace a read-only file; the restored image brings its own mode.
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error
      chmodSync(file, 0o666)
      renameSync(temporary, file)
    }
    // The journal may point at this file as soon as we return: make the rename durable too.
    if (process.platform !== "win32") {
      const dir = openSync(path.dirname(file), "r")
      try {
        fsyncSync(dir)
      } finally {
        closeSync(dir)
      }
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Whether `current` is `before` written over `after` from offset 0 and cut off at some byte. */
export function intermediate(current: Buffer, before: Buffer, after: Buffer): boolean {
  let prefix = 0
  while (prefix < current.length && prefix < before.length && current[prefix] === before[prefix]) prefix++
  // Longer than the post-image: every byte must be the pre-image's (cut at k = current.length).
  if (current.length > after.length) return prefix === current.length
  if (current.length !== after.length) return false
  let suffix = current.length
  while (suffix > 0 && current[suffix - 1] === after[suffix - 1]) suffix--
  return suffix <= prefix
}
