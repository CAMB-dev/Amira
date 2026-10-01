import { randomBytes } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type ArtifactInfo,
  countLines,
  DEFAULT_PREVIEW_CHARS,
  DEFAULT_SAVE_ABOVE,
  MAX_ARTIFACT_CHARS,
  type OutputLimits,
  type OutputStore,
  type SaveOutputOptions,
} from "@amira/api"

/** Megabytes of artifacts a session keeps by default (settings context.outputs.quotaMB). */
export const DEFAULT_ARTIFACT_QUOTA_MB = 256

const ID = /^a_[0-9a-f]{6,32}$/

/** A saved output, as its metadata file holds it; `pruned` once /prune deleted its text. */
export type StoredArtifact = ArtifactInfo

export interface ArtifactStoreOptions {
  /** Where the artifacts go: `<session>.assets/outputs` beside a session file (artifactDir). */
  dir: string
  sessionId: string
  limits?: Partial<OutputLimits>
  /** Most bytes of artifact text the session keeps. */
  quotaBytes?: number
  /** The store of the session this one was started from: find() falls back to it. */
  parent?: OutputStore
}

/** The session's artifact quota is used up; nothing was written. */
export class ArtifactQuotaError extends Error {}

/**
 * Where a session's artifacts live: next to its file (`<id>.assets/outputs`), or for a session
 * without one in the system's temp directory.
 */
export function artifactDir(sessionFile: string | undefined, sessionId: string): string {
  if (sessionFile) {
    return path.join(path.dirname(sessionFile), `${path.basename(sessionFile, ".jsonl")}.assets`, "outputs")
  }
  return path.join(tmpdir(), "amira", "outputs", sessionId)
}

/**
 * A session's saved tool outputs (A1): each a text file and a small metadata file. They live
 * as long as the session; nothing deletes them by itself. A quota bounds what one session
 * keeps: past it, saving fails and tools only preview. `prune` deletes on request.
 */
export class ArtifactStore implements OutputStore {
  readonly dir: string
  readonly sessionId: string
  readonly limits: OutputLimits
  readonly quotaBytes: number
  readonly #parent: OutputStore | undefined
  readonly #known = new Map<string, StoredArtifact>()
  #scanned = false
  #used = 0

  constructor(opts: ArtifactStoreOptions) {
    this.dir = opts.dir
    this.sessionId = opts.sessionId
    this.limits = {
      saveAbove: opts.limits?.saveAbove ?? DEFAULT_SAVE_ABOVE,
      previewChars: opts.limits?.previewChars ?? DEFAULT_PREVIEW_CHARS,
    }
    this.quotaBytes = opts.quotaBytes ?? DEFAULT_ARTIFACT_QUOTA_MB * 1024 * 1024
    this.#parent = opts.parent
  }

  /** Reads what an earlier run saved, once. */
  #scan() {
    if (this.#scanned) return
    this.#scanned = true
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const info = this.#readMeta(name.slice(0, -5))
      if (info && !this.#known.has(info.id)) {
        this.#known.set(info.id, info)
        if (!info.pruned) this.#used += info.bytes
      }
    }
  }

  #readMeta(id: string): StoredArtifact | undefined {
    if (!ID.test(id)) return undefined
    try {
      const raw = JSON.parse(readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as StoredArtifact
      if (raw?.id !== id || typeof raw.chars !== "number") return undefined
      // The directory may have moved with its session: the file is where the metadata is now.
      return { ...raw, path: path.join(this.dir, `${id}.txt`) }
    } catch {
      return undefined
    }
  }

  /** Bytes of artifact text this session keeps now. */
  get used(): number {
    this.#scan()
    return this.#used
  }

  /** This session's artifacts, pruned ones included, oldest first. */
  list(): StoredArtifact[] {
    this.#scan()
    return [...this.#known.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async save(opts: SaveOutputOptions): Promise<ArtifactInfo> {
    this.#scan()
    let text = opts.text
    let incomplete = opts.incomplete
    if (text.length > MAX_ARTIFACT_CHARS) {
      text = text.slice(0, MAX_ARTIFACT_CHARS)
      incomplete ??= `only the first ${MAX_ARTIFACT_CHARS.toLocaleString("en-US")} characters were saved`
    }
    const bytes = Buffer.byteLength(text)
    if (this.#used + bytes > this.quotaBytes) {
      const mb = Math.round(this.quotaBytes / (1024 * 1024))
      throw new ArtifactQuotaError(
        `this session's artifacts reached their ${mb} MB quota (context.outputs.quotaMB); /prune frees space`,
      )
    }
    const id = `a_${randomBytes(5).toString("hex")}`
    const file = path.join(this.dir, `${id}.txt`)
    const info: StoredArtifact = {
      id,
      path: file,
      tool: opts.tool,
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      sessionId: this.sessionId,
      chars: text.length,
      lines: countLines(text),
      bytes,
      complete: incomplete === undefined,
      ...(incomplete !== undefined ? { incomplete } : {}),
      createdAt: new Date().toISOString(),
    }
    // The text first, under a temporary name: an artifact is only ever found complete.
    const tmp = `${file}.tmp`
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(tmp, text)
      await rename(tmp, file)
      await writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(info))
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      await rm(file, { force: true }).catch(() => {})
      throw err
    }
    this.#known.set(id, info)
    this.#used += bytes
    return info
  }

  find(id: string): StoredArtifact | undefined {
    if (!ID.test(id)) return undefined
    const known = this.#known.get(id) ?? this.#readMeta(id)
    if (known) return known
    const inherited = this.#parent?.find(id)
    return inherited ? { ...inherited } : undefined
  }

  /**
   * Deletes these artifacts' text; their metadata stays, marked pruned, so reading one says
   * what happened to it. Returns how many were deleted and the bytes freed.
   */
  async prune(ids: Iterable<string>): Promise<{ removed: number; bytes: number }> {
    this.#scan()
    let removed = 0
    let bytes = 0
    for (const id of ids) {
      const info = this.#known.get(id)
      if (!info || info.pruned) continue
      await rm(path.join(this.dir, `${id}.txt`), { force: true })
      const marked: StoredArtifact = { ...info, pruned: new Date().toISOString() }
      await writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(marked)).catch(() => {})
      this.#known.set(id, marked)
      this.#used -= info.bytes
      bytes += info.bytes
      removed++
    }
    return { removed, bytes }
  }

  /** Whether an artifact's text is still on disk. */
  exists(info: ArtifactInfo): boolean {
    try {
      return statSync(info.path).isFile()
    } catch {
      return false
    }
  }
}

/** Every artifact id a text mentions (a preview, a stub, a session file line). */
export function artifactIdsIn(text: string): string[] {
  return [...text.matchAll(/\ba_[0-9a-f]{10}\b/g)].map((m) => m[0])
}

/** Which artifacts /prune deletes: unreferenced ones, those and ones only old history mentions, or all. */
export type ArtifactScope = "unused" | "inactive" | "all"

/** A session's artifacts by how they are referenced (Agent.artifactUsage). */
export interface ArtifactUsage {
  active: ArtifactInfo[]
  inactive: ArtifactInfo[]
  unused: ArtifactInfo[]
  pruned: ArtifactInfo[]
  /** Bytes of the artifacts not pruned. */
  bytes: number
}

/**
 * Every artifact id a session file mentions, on any branch, and the files of its sub-agents
 * (which may be pointed at their parent's artifacts), at any depth.
 */
export function referencedArtifacts(session: { file: string; entries: readonly object[] }): Set<string> {
  const out = new Set<string>()
  const seen = new Set<string>()
  const scan = (file: string, entries: readonly object[]) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const e of entries) {
      for (const id of artifactIdsIn(JSON.stringify(e))) out.add(id)
      const child = (e as { type?: unknown; childSessionId?: unknown }).childSessionId
      if (
        (e as { type?: unknown }).type === "subagent" &&
        typeof child === "string" &&
        /^[\w-]+$/.test(child)
      ) {
        const childFile = path.join(path.dirname(file), "subagents", `${child}.jsonl`)
        scan(childFile, readEntries(childFile))
      }
    }
  }
  scan(session.file, session.entries)
  return out
}

/** A session file's lines that parse, for scanning; none when it cannot be read. */
function readEntries(file: string): object[] {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  return text.split("\n").flatMap((line) => {
    try {
      const v = JSON.parse(line) as unknown
      return v && typeof v === "object" ? [v] : []
    } catch {
      return []
    }
  })
}
