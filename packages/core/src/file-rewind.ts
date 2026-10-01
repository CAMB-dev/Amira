import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { FileMutation, FileRewindPlan, Settings } from "@amira/api"
import type { SessionEntry, SessionStore } from "./session-store.ts"

interface FileImage {
  path: string
  before: string | null
  after: string | null
  mode?: number
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
  | { type: "file_mutation_end"; mutationId: string; rolledBack: boolean }
  | { type: "file_restore"; messageId: string; target: string | null; files: FileImage[] }
  | { type: "file_restore_progress"; restoreId: string; path: string }
  | { type: "file_restore_end"; restoreId: string }
  | { type: "file_prune" }

type Mutation = Extract<SessionEntry, { type: "file_mutation" }>
type Restore = Extract<SessionEntry, { type: "file_restore" }>

export const FILE_REWIND_COVERAGE =
  "Only write, edit and apply_patch changes are covered, including same-directory sub-agents. Shell commands, hook formatters, other processes, user edits and separate worktrees are not captured."

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

  constructor(
    readonly store: SessionStore,
    settings: Settings["fileRewind"] = {},
  ) {
    this.directory = path.join(store.directory, "files")
    this.enabled = settings.enabled !== false
    this.maxFileBytes = settings.maxFileBytes ?? 10 * 1024 * 1024
    this.quotaBytes = settings.quotaBytes ?? 256 * 1024 * 1024
  }

  get busy(): boolean {
    return this.#active > 0
  }

  get restoring(): boolean {
    return this.#pending() !== undefined
  }

  async mutate(
    changes: FileMutation[],
    write: () => Promise<void>,
    source: { sessionId: string; toolCallId: string; turnId: string },
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
        throw new Error("An interrupted file restore must finish before file tools can write")
      if (!this.enabled) return await write()
      const message = this.store.branch().findLast((e) => e.type === "message" && e.message.role === "user")
      if (!message) throw new Error("Cannot capture file changes without a stored user message")
      const files: FileImage[] = []
      const seen = new Set<string>()
      try {
        for (const change of changes) {
          const file = path.resolve(change.path)
          const key = process.platform === "win32" ? file.toLowerCase() : file
          if (seen.has(key)) throw new Error(`Duplicate mutation path: ${file}`)
          seen.add(key)
          const before = this.#read(file, this.maxFileBytes)
          if (change.before !== undefined && hash(change.before) !== hash(before.bytes)) {
            throw new Error(`File changed before writing: ${file}; read it again`)
          }
          files.push({
            path: file,
            before: this.#put(before.bytes),
            after: this.#put(change.after),
            ...(before.mode === undefined ? {} : { mode: before.mode }),
          })
        }
      } catch (error) {
        throw new Error(`File rewind capture failed; write refused: ${(error as Error).message}`)
      }
      // Failure here must propagate, unlike best-effort conversation persistence.
      const id = this.store.appendDurable({ type: "file_mutation", messageId: message.id, ...source, files })
      try {
        await write()
      } catch (error) {
        // A patch owns its rollback. A torn/partial write remains pending and conflicts on rewind.
        if (files.every((f) => this.#current(f.path) === f.before)) {
          this.store.appendDurable({ type: "file_mutation_end", mutationId: id, rolledBack: true })
        }
        throw error
      }
      this.store.appendDurable({ type: "file_mutation_end", mutationId: id, rolledBack: false })
    } finally {
      this.#active--
      release()
    }
  }

  plan(messageId: string): FileRewindPlan {
    const pending = this.#pending()
    if (pending && pending.messageId !== messageId) throw new Error("Resume the interrupted rewind first")
    const { files, conflicts, pruned } = pending
      ? { files: pending.files, conflicts: this.#checkRestore(pending).conflicts, pruned: false }
      : this.#plan(messageId)
    return {
      owner: "core",
      enabled: pending !== undefined || (this.enabled && !pruned),
      restored: files.filter((f) => f.before !== null).length,
      removed: files.filter((f) => f.before === null).length,
      conflicts,
      note: `${pending ? "Resume the interrupted file restore. " : !this.enabled ? "Capture is disabled; files will not be restored. " : pruned ? "File history was pruned; files will not be restored. " : ""}${FILE_REWIND_COVERAGE}`,
    }
  }

  /** Restores files and checks out the conversation as one resumable operation. */
  restore(messageId: string, target: string | null): void {
    this.#idle()
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
    this.#apply(pending)
    return {
      restored: pending.files.filter((f) => f.before !== null).length,
      removed: pending.files.filter((f) => f.before === null).length,
    }
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
    const mutations = branch
      .slice(boundary)
      .filter((e): e is Mutation => e.type === "file_mutation" && !rollback.has(e.id))
    const pruneAt = this.store.entries.findLastIndex((e) => e.type === "file_prune")
    if (mutations.some((e) => this.store.entries.indexOf(e) < pruneAt)) {
      return { files: [], conflicts: [], pruned: true }
    }
    const files = new Map<string, FileImage>()
    const conflicts = new Set<string>()
    for (const mutation of mutations) {
      for (const image of mutation.files) {
        // After a crash, an uncommitted tool may have written none or some of its files.
        const after =
          !committed.has(mutation.id) && this.#current(image.path) === image.before
            ? image.before
            : image.after
        const key = process.platform === "win32" ? image.path.toLowerCase() : image.path
        const earlier = files.get(key)
        if (earlier && earlier.after !== image.before) conflicts.add(image.path)
        files.set(key, {
          ...image,
          before: earlier ? earlier.before : image.before,
          mode: earlier?.mode ?? image.mode,
          after,
        })
      }
    }
    for (const file of files.values()) {
      if (this.#current(file.path) !== file.after) conflicts.add(file.path)
      try {
        if (file.before !== null) this.#blob(file.before)
      } catch {
        conflicts.add(`${file.path} (missing or damaged pre-image)`)
      }
    }
    return { files: [...files.values()], conflicts: [...conflicts], pruned: false }
  }

  #checkRestore(restore: Restore) {
    const progress = new Set(
      this.store.entries.flatMap((e) =>
        e.type === "file_restore_progress" && e.restoreId === restore.id ? [e.path] : [],
      ),
    )
    const conflicts: string[] = []
    const images = new Map<string, Buffer>()
    // Validate the entire operation, including already completed files, before resuming it.
    for (const file of restore.files) {
      const current = this.#current(file.path)
      if (current !== file.before && (progress.has(file.path) || current !== file.after))
        conflicts.push(file.path)
      try {
        if (file.before !== null) images.set(file.path, this.#blob(file.before))
      } catch {
        conflicts.push(`${file.path} (missing or damaged pre-image)`)
      }
    }
    return { progress, conflicts, images }
  }

  #apply(restore: Restore) {
    const { progress, conflicts, images } = this.#checkRestore(restore)
    if (conflicts.length) throw new FileRewindConflictError(conflicts)
    for (const file of restore.files) {
      if (progress.has(file.path)) continue
      const current = this.#current(file.path)
      if (current !== file.before) {
        if (current !== file.after)
          throw new Error(
            `File changed during restore: ${file.path}; resolve it and resume the interrupted restore`,
          )
        if (file.before === null) unlinkSync(file.path)
        else {
          mkdirSync(path.dirname(file.path), { recursive: true })
          atomicWrite(file.path, images.get(file.path)!, file.mode)
        }
      }
      this.store.appendDurable({ type: "file_restore_progress", restoreId: restore.id, path: file.path })
    }
    // The end marker follows checkout: a crash in either gap can replay the checkout safely.
    this.store.appendDurable({ type: "checkout", target: restore.target })
    this.store.appendDurable({ type: "file_restore_end", restoreId: restore.id })
  }

  #read(file: string, limit = Number.POSITIVE_INFINITY): { bytes: Buffer | null; mode?: number } {
    // Replacing a symlink or an aliased inode would restore a different object than was captured.
    for (let at = file; ; at = path.dirname(at)) {
      try {
        const st = lstatSync(at)
        if (st.isSymbolicLink()) throw new Error(`Symbolic links cannot be captured/restored: ${at}`)
        if (at === file) {
          if (!st.isFile() || st.nlink > 1) throw new Error(`Not an unlinked regular file: ${file}`)
          if (st.size > limit) throw new Error(`${file} exceeds fileRewind.maxFileBytes (${limit} bytes)`)
        } else if (!st.isDirectory()) throw new Error(`Not a directory: ${at}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (at === this.store.header.cwd || path.dirname(at) === at) break
    }
    try {
      const bytes = readFileSync(file)
      if (bytes.length > limit) throw new Error(`${file} exceeds fileRewind.maxFileBytes (${limit} bytes)`)
      return { bytes, mode: statSync(file).mode }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null }
      throw error
    }
  }

  #current(file: string): string | null | undefined {
    try {
      return hash(this.#read(file).bytes)
    } catch {
      return undefined
    }
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
      this.#blob(key)
      return key
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

function hash(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex")
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
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}
