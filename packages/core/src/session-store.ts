import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { AssistantMessage, Message, ModelRef } from "@amira/ai"
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
}

/** Sessions for a working directory live in `~/.amira/sessions/<hash of cwd>/`. */
export function sessionsDir(cwd: string): string {
  const key = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd)
  return amiraPath("sessions", createHash("sha256").update(key).digest("hex").slice(0, 16))
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
  #leaf: string | null = null
  #written: boolean
  /** The file ends in a torn line; the next write starts on a fresh line. */
  #needsNewline = false
  #pending: string[] = []

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
    const raw = readFileSync(file, "utf8")
    const lines = raw.split("\n")
    const header = parseLine(lines[0] ?? "")
    if (!isHeader(header)) throw new Error(`not an Amira session file: ${file}`)
    const store = new SessionStore(file, header, true)
    for (const line of lines.slice(1)) {
      const e = parseLine(line)
      if (isEntry(e)) store.#add(e)
    }
    store.#needsNewline = raw.length > 0 && !raw.endsWith("\n")
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
    this.#add(entry)
    this.#write(JSON.stringify(entry), entry.type === "message")
    return entry.id
  }

  appendMessage(message: Message): string {
    return this.append({ type: "message", message })
  }

  /** Entries from the root to the tip of the current branch. */
  branch(): SessionEntry[] {
    const out: SessionEntry[] = []
    const seen = new Set<string>()
    for (let id = this.#leaf; id && !seen.has(id); ) {
      seen.add(id)
      const e = this.#byId.get(id)
      if (!e) break
      out.push(e)
      id = e.parentId
    }
    return out.reverse()
  }

  /** Rebuilds the conversation on the current branch, applying compactions. */
  restore(): RestoredSession {
    let items: { id: string; message: Message }[] = []
    let model: ModelRef | undefined
    for (const e of this.branch()) {
      if (e.type === "message") items.push({ id: e.id, message: e.message })
      else if (e.type === "model_change") model = e.model
      else if (e.type === "compaction") {
        const gone = new Set(e.replaces)
        const at = items.findIndex((i) => gone.has(i.id))
        const kept = items.filter((i) => !gone.has(i.id))
        const summary = summaryMessages(e.summary, model).map((message) => ({ id: e.id, message }))
        items = [...kept.slice(0, Math.max(0, at)), ...summary, ...kept.slice(Math.max(0, at))]
      }
    }
    const entryIds = new Map<Message, string>()
    for (const i of items) entryIds.set(i.message, i.id)
    return { messages: items.map((i) => i.message), entryIds, ...(model ? { model } : {}) }
  }

  /** The model most recently recorded on the current branch. */
  model(): ModelRef | undefined {
    let model: ModelRef | undefined
    for (const e of this.branch()) if (e.type === "model_change") model = e.model
    return model
  }

  #add(e: SessionEntry) {
    this.#entries.push(e)
    this.#byId.set(e.id, e)
    this.#leaf = e.type === "checkout" ? e.target : e.id
  }

  /** Buffers until the first message, then writes the header and everything since. */
  #write(line: string, isMessage: boolean) {
    if (!this.#written) {
      this.#pending.push(line)
      if (!isMessage) return
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${[JSON.stringify(this.header), ...this.#pending].join("\n")}\n`)
      this.#pending = []
      this.#written = true
      return
    }
    appendFileSync(this.file, `${this.#needsNewline ? "\n" : ""}${line}\n`)
    this.#needsNewline = false
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
