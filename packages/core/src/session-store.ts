import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { AssistantMessage, Message, ModelRef } from "@amira/ai"
import { contextTokens } from "./compaction.ts"
import { amiraPath } from "./home.ts"

export interface SessionHeader {
  type: "session"
  v: 1
  id: string
  cwd: string
  createdAt: string
  /** The session this one was forked from, if any. */
  parent: string | null
}

export type SessionEntryData =
  | { type: "message"; message: Message }
  | { type: "model_change"; model: ModelRef }
  /** `summary` stands in for the entries in `replaces`; they stay in the file. */
  | { type: "compaction"; summary: string; replaces: string[] }
  /** Makes `target` the tip of the current branch. */
  | { type: "checkout"; target: string }
  | { type: "subagent"; childSessionId: string; role: string }
  | { type: "custom"; ext: string; data: unknown }

export type SessionEntry = SessionEntryData & { id: string; parentId: string | null; ts: number }

/** Messages rebuilt from a branch, with the entry id each one came from. */
export interface RestoredSession {
  messages: Message[]
  entryIds: Map<Message, string>
  model?: ModelRef
  /** Context size from the last reply since the last compaction; older usage no longer applies. */
  contextTokens?: number
}

/**
 * Names a working directory in per-project files under the user directory: a hash of its
 * resolved path (case-insensitive on Windows), e.g. for sessions and the prompt history.
 */
export function projectKey(cwd: string): string {
  const key = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd)
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/** Sessions for a working directory live in `~/.amira/sessions/<project key>/`. */
export function sessionsDir(cwd: string): string {
  return amiraPath("sessions", projectKey(cwd))
}

export function newSessionId(): string {
  return `s_${crypto.randomUUID().slice(0, 8)}`
}

/**
 * A tree-shaped, append-only JSONL session file (D17). The first line is a header;
 * every later line is an entry pointing at its parent. Nothing is ever rewritten.
 * The file is only created once the first message arrives, so sessions that never
 * say anything leave nothing behind.
 */
export class SessionStore {
  readonly file: string
  readonly header: SessionHeader
  readonly #entries: SessionEntry[] = []
  readonly #byId = new Map<string, SessionEntry>()
  /** The tip each entry was appended under, in file order: the fallback for a missing parent. */
  readonly #tipBefore = new Map<string, string | null>()
  #leaf: string | null = null
  #written: boolean
  /** The file ends in a torn line; the next write starts on a fresh line. */
  #needsNewline = false
  #pending: string[] = []
  /** Bytes in the file as far as this store knows; any other size means another writer. */
  #size = 0

  private constructor(file: string, header: SessionHeader, written: boolean) {
    this.file = file
    this.header = header
    this.#written = written
  }

  static create(opts: { cwd: string; id?: string; parent?: string; dir?: string }): SessionStore {
    const id = opts.id ?? newSessionId()
    const dir = opts.dir ?? sessionsDir(opts.cwd)
    const header: SessionHeader = {
      type: "session",
      v: 1,
      id,
      cwd: opts.cwd,
      createdAt: new Date().toISOString(),
      parent: opts.parent ?? null,
    }
    return new SessionStore(path.join(dir, `${id}.jsonl`), header, false)
  }

  /** Reads a session file. Lines that do not parse, such as a torn last line, are skipped. */
  static open(file: string): SessionStore {
    const bytes = readFileSync(file)
    const raw = bytes.toString("utf8")
    const lines = raw.split("\n")
    const header = parseLine(lines[0] ?? "")
    if (!isHeader(header)) throw new Error(`not an Amira session file: ${file}`)
    const store = new SessionStore(file, header, true)
    for (const line of lines.slice(1)) {
      const e = parseLine(line)
      if (isEntry(e)) store.#add(e)
    }
    store.#needsNewline = raw.length > 0 && !raw.endsWith("\n")
    store.#size = bytes.length
    return store
  }

  get id(): string {
    return this.header.id
  }

  get entries(): readonly SessionEntry[] {
    return this.#entries
  }

  /** The tip of the current branch. */
  get leafId(): string | null {
    return this.#leaf
  }

  get(id: string): SessionEntry | undefined {
    return this.#byId.get(id)
  }

  /** Appends an entry as a child of the current tip and returns its id. */
  append(data: SessionEntryData): string {
    const entry = {
      ...data,
      id: `e_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      parentId: this.#leaf,
      ts: Date.now(),
    } as SessionEntry
    if (entry.type === "checkout" && !this.#byId.has(entry.target)) {
      throw new Error(`unknown entry ${entry.target}`)
    }
    // Written first, so a failed write leaves no entry behind for later ones to point at.
    this.#write(JSON.stringify(entry), entry.type === "message")
    this.#add(entry)
    return entry.id
  }

  appendMessage(message: Message): string {
    return this.append({ type: "message", message })
  }

  /**
   * Entries from the root to the tip of the current branch. A parent missing from the file
   * (a damaged file) is bridged to whatever was the tip before that entry, in file order.
   */
  branch(): SessionEntry[] {
    const out: SessionEntry[] = []
    const seen = new Set<string>()
    for (let id = this.#leaf; id && !seen.has(id); ) {
      seen.add(id)
      const e = this.#byId.get(id)
      if (!e) break
      out.push(e)
      id = e.parentId && !this.#byId.has(e.parentId) ? (this.#tipBefore.get(e.id) ?? null) : e.parentId
    }
    return out.reverse()
  }

  /** Rebuilds the conversation on the current branch, applying compactions. */
  restore(): RestoredSession {
    let items: { id: string; message: Message }[] = []
    let model: ModelRef | undefined
    let tokens: number | undefined
    for (const e of this.branch()) {
      if (e.type === "message") {
        items.push({ id: e.id, message: e.message })
        if (e.message.role === "assistant" && e.message.usage) tokens = contextTokens(e.message.usage)
      } else if (e.type === "model_change") model = e.model
      else if (e.type === "compaction") {
        tokens = undefined
        const gone = new Set(e.replaces)
        const at = items.findIndex((i) => gone.has(i.id))
        const kept = items.filter((i) => !gone.has(i.id))
        const summary = summaryMessages(e.summary, model).map((message) => ({ id: e.id, message }))
        items = [...kept.slice(0, Math.max(0, at)), ...summary, ...kept.slice(Math.max(0, at))]
      }
    }
    const entryIds = new Map<Message, string>()
    for (const i of items) entryIds.set(i.message, i.id)
    return {
      messages: items.map((i) => i.message),
      entryIds,
      ...(model ? { model } : {}),
      ...(tokens !== undefined ? { contextTokens: tokens } : {}),
    }
  }

  /** The model most recently recorded on the current branch. */
  model(): ModelRef | undefined {
    let model: ModelRef | undefined
    for (const e of this.branch()) if (e.type === "model_change") model = e.model
    return model
  }

  #add(e: SessionEntry) {
    this.#tipBefore.set(e.id, this.#leaf)
    this.#entries.push(e)
    this.#byId.set(e.id, e)
    if (e.type !== "checkout") this.#leaf = e.id
    else if (this.#byId.has(e.target)) this.#leaf = e.target
  }

  /** Buffers until the first message, then writes the header and everything since. */
  #write(line: string, isMessage: boolean) {
    if (!this.#written) {
      if (!isMessage) {
        this.#pending.push(line)
        return
      }
      mkdirSync(path.dirname(this.file), { recursive: true })
      const text = `${[JSON.stringify(this.header), ...this.#pending, line].join("\n")}\n`
      appendFileSync(this.file, text)
      this.#size = Buffer.byteLength(text)
      this.#pending = []
      this.#written = true
      return
    }
    // Two stores appending to one file would interleave two parent chains, and a resume
    // would follow only one of them. The first to write wins; the other stops saving.
    if (statSync(this.file).size !== this.#size) throw new SessionConflictError(this.file)
    const text = `${this.#needsNewline ? "\n" : ""}${line}\n`
    try {
      appendFileSync(this.file, text)
      this.#size += Buffer.byteLength(text)
      this.#needsNewline = false
    } catch (err) {
      // Part of the line may have landed; the next one starts on a fresh line.
      this.#needsNewline = true
      this.#size = sizeOf(this.file) ?? this.#size
      throw err
    }
  }
}

/** Another process appended to the session file since this store last read or wrote it. */
export class SessionConflictError extends Error {
  constructor(file: string) {
    super(`${file} was changed by another process (is this session open twice?); this one is no longer saved`)
  }
}

function sizeOf(file: string): number | undefined {
  try {
    return statSync(file).size
  } catch {
    return undefined
  }
}

const SUMMARY_PREFIX = "The earlier part of this conversation was compacted. Summary:"

/**
 * How a compaction summary appears in the conversation: a user message with the summary
 * and a short assistant acknowledgement, so roles keep alternating for every provider.
 */
export function summaryMessages(summary: string, model?: ModelRef): Message[] {
  const ack: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Understood. I will continue from this summary." }],
    model: model ?? { provider: "amira", model: "compaction" },
    stopReason: "end",
  }
  return [{ role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\n${summary.trim()}` }] }, ack]
}

function parseLine(line: string): unknown {
  if (!line.trim()) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function isHeader(v: unknown): v is SessionHeader {
  const h = v as SessionHeader | undefined
  return h?.type === "session" && typeof h.id === "string"
}

const ENTRY_TYPES = new Set<unknown>([
  "message",
  "model_change",
  "compaction",
  "checkout",
  "subagent",
  "custom",
])

function isEntry(v: unknown): v is SessionEntry {
  const e = v as { id?: unknown; type?: unknown } | undefined
  return typeof e?.id === "string" && ENTRY_TYPES.has(e.type)
}
