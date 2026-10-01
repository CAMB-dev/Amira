import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Message, ModelRef, Signature, Usage } from "@amira/ai"
import type { CompactionInfo, CompactionReason } from "@amira/api"
import { contextTokens, summaryMessages } from "./compaction.ts"
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
  | { type: "title"; title: string; source: "manual" | "auto" }
  | { type: "side_usage"; model: ModelRef; usage: Usage }
  | { type: "message"; message: Message }
  | { type: "model_change"; model: ModelRef }
  /**
   * `summary` stands in for the entries in `replaces`; they stay in the file. Why and how it
   * was compacted (CompactionInfo) is missing from entries written before it was kept, as are
   * the optional fields of CompactionExtras.
   */
  | ({ type: "compaction"; summary: string; replaces: string[] } & Partial<CompactionInfo> & CompactionExtras)
  /** Makes `target` the tip of the current branch; null goes back to before the first entry. */
  | { type: "checkout"; target: string | null }
  | { type: "subagent"; childSessionId: string; role: string; title?: string }
  /** Deferred tools the session loaded (via tool_search), offered to the model from then on. */
  | { type: "tools_loaded"; names: string[] }
  | { type: "custom"; ext: string; data: unknown }

/** Optional fields of a compaction entry (no session format version depends on them). */
export interface CompactionExtras {
  /**
   * The provider's checkpoint of a server-side compaction (Signature.kind "checkpoint", with
   * its provider, host and model). `summary` is then the server's readable text, or empty.
   */
  checkpoint?: Signature
  /**
   * Entries kept verbatim before the summary, in order ("recent-user" layout). They are also
   * in `replaces`, so an Amira that does not know this field drops them.
   */
  retained?: string[]
  /** Tokens and cost of the compaction's requests. */
  usage?: Usage
  /**
   * This entry writes a text summary for an earlier compaction entry, whose checkpoint a model
   * switched to could not read: it replaces that entry (`replaces` holds only its id) and
   * keeps its checkpoint, so the original model can still use it.
   */
  fills?: string
}

export type SessionEntry = SessionEntryData & { id: string; parentId: string | null; ts: number }

/** Messages rebuilt from a branch, with the entry id each one came from. */
export interface RestoredSession {
  messages: Message[]
  entryIds: Map<Message, string>
  model?: ModelRef
  /** Context size from the last reply since the last compaction; older usage no longer applies. */
  contextTokens?: number
  /** Deferred tools loaded on this branch, in load order. */
  loadedTools: string[]
  /** Why each compaction happened, by its summary's user message; none for old entries. */
  compactions: Map<Message, CompactionInfo>
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

  get title(): string | undefined {
    const entries = this.#entries.filter(
      (e): e is Extract<SessionEntry, { type: "title" }> => e.type === "title" && typeof e.title === "string",
    )
    return entries.findLast((e) => e.source === "manual")?.title ?? entries.at(-1)?.title
  }

  rename(title: string, source: "manual" | "auto" = "manual"): void {
    const clean = title
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
    if (!clean) throw new Error("a session title must not be empty")
    if (source === "auto" && this.#entries.some((e) => e.type === "title" && e.source === "manual")) return
    this.append({ type: "title", title: clean, source })
  }

  /** Copies the stored history through target, retaining entry ids used by compactions. */
  fork(target: string | null = this.#leaf): SessionStore {
    const at = target === null ? -1 : this.#entries.findIndex((e) => e.id === target)
    if (target !== null && at === -1) throw new Error(`unknown entry ${target}`)
    const next = SessionStore.create({ cwd: this.header.cwd, parent: this.id, dir: path.dirname(this.file) })
    const entries = this.#entries.slice(0, at + 1)
    const text = `${[JSON.stringify(next.header), ...entries.map((e) => JSON.stringify(e))].join("\n")}\n`
    mkdirSync(path.dirname(next.file), { recursive: true })
    writeFileSync(next.file, text, { flag: "wx" })
    next.#written = true
    next.#size = Buffer.byteLength(text)
    for (const e of entries) next.#add(e)
    if (next.leafId !== target) next.append({ type: "checkout", target })
    next.rename(`${this.title ?? this.id} (fork)`)
    return next
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
    if (entry.type === "checkout" && entry.target !== null && !this.#byId.has(entry.target)) {
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
    const loadedTools = new Set<string>()
    const compactions = new Map<Message, CompactionInfo>()
    for (const e of this.branch()) {
      if (e.type === "tools_loaded") {
        for (const name of Array.isArray(e.names) ? e.names : []) {
          if (typeof name === "string") loadedTools.add(name)
        }
      } else if (e.type === "message") {
        items.push({ id: e.id, message: e.message })
        // An interrupted reply may carry no usage counted; the context is still the one before.
        const used = e.message.role === "assistant" && e.message.usage ? contextTokens(e.message.usage) : 0
        if (used > 0) tokens = used
      } else if (e.type === "model_change") model = e.model
      else if (e.type === "compaction") {
        tokens = undefined
        // As in the agent, the summary goes first (after the user messages the "recent-user"
        // layout keeps) and what it does not replace follows in order: in a long turn that is
        // the turn's prompt and its latest steps.
        const gone = new Set(Array.isArray(e.replaces) ? e.replaces : [])
        const checkpoint = checkpointIn(e.checkpoint)
        const info = compactionInfo(e)
        const summary = summaryMessages(
          typeof e.summary === "string" ? e.summary : "",
          info?.model ?? model,
          checkpoint,
        ).map((message) => ({ id: e.id, message }))
        if (info && summary[0]) compactions.set(summary[0].message, info)
        const keep = new Set(Array.isArray(e.retained) ? e.retained : [])
        const retained = items.filter((i) => keep.has(i.id))
        items = [...retained, ...summary, ...items.filter((i) => !gone.has(i.id) && !keep.has(i.id))]
      }
    }
    const entryIds = new Map<Message, string>()
    for (const i of items) entryIds.set(i.message, i.id)
    return {
      messages: items.map((i) => i.message),
      entryIds,
      ...(model ? { model } : {}),
      ...(tokens !== undefined ? { contextTokens: tokens } : {}),
      loadedTools: [...loadedTools],
      compactions,
    }
  }

  /**
   * The history a compaction entry stands for, rebuilt from the file: the messages it
   * replaced, with an earlier compaction among them standing as its summary when it has
   * readable text, else as what it replaced in turn. Undefined for an unknown entry.
   */
  compacted(entryId: string): Message[] | undefined {
    const e = this.#byId.get(entryId)
    if (e?.type !== "compaction") return undefined
    const seen = new Set<string>()
    const expand = (c: Extract<SessionEntry, { type: "compaction" }>): Message[] =>
      (Array.isArray(c.replaces) ? c.replaces : []).flatMap((id): Message[] => {
        if (seen.has(id)) return []
        seen.add(id)
        const r = this.#byId.get(id)
        if (r?.type === "message") return [r.message]
        if (r?.type !== "compaction") return []
        return typeof r.summary === "string" && r.summary.trim() ? summaryMessages(r.summary) : expand(r)
      })
    return expand(e)
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
    // Session-wide notes stay off the branch: a rewind keeps the name, and an older Amira that
    // skips these entry types never sees a message or checkout pointing at one.
    if (e.type === "title" || e.type === "side_usage") return
    if (e.type !== "checkout") this.#leaf = e.id
    else if (e.target === null) this.#leaf = null
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

function parseLine(line: string): unknown {
  if (!line.trim()) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

const REASONS = new Set<unknown>(["threshold", "manual", "overflow"] satisfies CompactionReason[])

/** What a compaction entry says about why it happened; undefined for entries without it. */
function compactionInfo(e: Partial<CompactionInfo>): CompactionInfo | undefined {
  if (!REASONS.has(e.reason)) return undefined
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined)
  const out: CompactionInfo = { reason: e.reason as CompactionReason }
  const before = count(e.tokensBefore)
  const after = count(e.tokensAfter)
  const window = count(e.contextWindow)
  if (before !== undefined) out.tokensBefore = before
  if (after !== undefined) out.tokensAfter = after
  if (window) out.contextWindow = window
  const m = e.model as Partial<ModelRef> | undefined
  if (typeof m?.provider === "string" && typeof m.model === "string") {
    out.model = { provider: m.provider, model: m.model }
  }
  const n = e.native as Partial<ModelRef> | undefined
  if (typeof n?.provider === "string" && typeof n.model === "string") {
    out.native = { provider: n.provider, model: n.model }
  }
  if (e.layout === "tail" || e.layout === "recent-user") out.layout = e.layout
  if (typeof e.fallback === "string" && e.fallback) out.fallback = e.fallback
  return out
}

/** A stored checkpoint, if it is one (a damaged or foreign entry may hold anything). */
function checkpointIn(v: unknown): Signature | undefined {
  const s = v as Partial<Signature> | undefined
  const str = (x: unknown) => typeof x === "string" && x.length > 0
  if (s?.kind !== "checkpoint" || !str(s.dialect) || !str(s.value)) return undefined
  if (!str(s.provider) || !str(s.host) || !str(s.model)) return undefined
  return {
    dialect: s.dialect!,
    value: s.value!,
    kind: "checkpoint",
    provider: s.provider!,
    host: s.host!,
    model: s.model!,
  }
}

function isHeader(v: unknown): v is SessionHeader {
  const h = v as SessionHeader | undefined
  return h?.type === "session" && typeof h.id === "string"
}

const ENTRY_TYPES = new Set<unknown>([
  "title",
  "side_usage",
  "message",
  "model_change",
  "compaction",
  "checkout",
  "subagent",
  "tools_loaded",
  "custom",
])

function isEntry(v: unknown): v is SessionEntry {
  const e = v as { id?: unknown; type?: unknown } | undefined
  return typeof e?.id === "string" && ENTRY_TYPES.has(e.type)
}
