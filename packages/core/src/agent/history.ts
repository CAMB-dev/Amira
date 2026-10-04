// Owns the live conversation, its projections and session persistence.
import { type Message, unansweredCalls } from "@amira/ai"
import type { CompactionInfo, SessionData } from "@amira/api"
import { type ContextView, projectMessages, type StoredView } from "../context.ts"
import type { SessionEntryData, SessionStore } from "../session-store.ts"
import { toolError } from "./messages.ts"

/** Forked views only follow kept messages; restored session views are already authoritative. */
export function keptHistoryViews(
  messages: Message[],
  source: ReadonlyMap<Message, ContextView> | undefined,
): Map<Message, ContextView> {
  const views = new Map<Message, ContextView>()
  if (source) {
    const kept = new Set(messages)
    for (const [m, v] of source) {
      if (kept.has(m) && (v.kind !== "duplicate" || kept.has(v.of))) views.set(m, v)
    }
  }
  return views
}

interface HistoryDeps {
  session: SessionStore | undefined
  reportStoreError: (error: string) => void
  originals: ((summary: Message) => Message[] | undefined) | undefined
}

/** The live conversation and its persistence; context and compaction decisions stay with the caller. */
export class History {
  readonly messages: Message[]
  /**
   * How tool results are sent instead of their content (context management, A0): decided once
   * per result and kept, so later requests repeat the same text.
   */
  readonly views: Map<Message, ContextView>
  #deps: HistoryDeps
  /** The session entry each message was stored as. */
  #entryIds: Map<Message, string>
  /** Why each compaction in `messages` happened, by its summary's user message. */
  #compactions = new WeakMap<Message, CompactionInfo>()
  /** The history each server checkpoint made in this run stands for, by its summary's user message. */
  #compacted = new WeakMap<Message, Message[]>()
  #storeFailed = false
  /** Extension records of a session without a file (see `data`). */
  #records: { key: string; data: unknown }[] = []

  /**
   * Records extensions keep in this session (SessionData): custom entries of its file, or
   * kept in memory when it has none.
   */
  readonly data: SessionData = {
    append: (key, data) => {
      const copy = JSON.parse(JSON.stringify(data ?? null)) as unknown
      if (this.#deps.session) this.store({ type: "custom", ext: key, data: copy })
      else this.#records.push({ key, data: copy })
    },
    read: (key) => {
      const all = this.#deps.session
        ? this.#deps.session.branch().flatMap((e) => (e.type === "custom" && e.ext === key ? [e.data] : []))
        : this.#records.filter((r) => r.key === key).map((r) => r.data)
      return all.map((d) => structuredClone(d))
    },
  }

  constructor(
    deps: HistoryDeps,
    init: {
      messages: Message[]
      views?: Map<Message, ContextView>
      entryIds?: Map<Message, string>
      compactions?: Iterable<[Message, CompactionInfo]>
    },
  ) {
    this.#deps = deps
    this.messages = init.messages
    this.views = init.views ?? new Map()
    this.#entryIds = init.entryIds ?? new Map()
    for (const [m, info] of init.compactions ?? []) this.#compactions.set(m, info)
  }

  get storeFailed(): boolean {
    return this.#storeFailed
  }

  /** Adds messages to the history and persists each one. */
  push(...messages: Message[]): void {
    for (const m of messages) {
      this.messages.push(m)
      const id = this.store({ type: "message", message: m })
      if (id) this.#entryIds.set(m, id)
    }
  }

  /** Appends to the session file. A failing disk is reported once and never breaks the turn. */
  store(entry: SessionEntryData): string | undefined {
    if (!this.#deps.session) return undefined
    try {
      return this.#deps.session.append(entry)
    } catch (err) {
      if (!this.#storeFailed) {
        this.#storeFailed = true
        const error = `could not save the session: ${err instanceof Error ? err.message : String(err)}`
        this.#deps.reportStoreError(error)
      }
      return undefined
    }
  }

  /** Guarantees every tool call in history has a result, so the next request is valid. */
  repair(): void {
    const missing = [...unansweredCalls(this.messages)]
    this.push(...missing.map((b) => toolError(b, "This tool call did not complete.", "aborted")))
  }

  /** Records views in the session file, so a resumed session sends the same. */
  storeViews(views: [Message, ContextView][]): void {
    const stored: StoredView[] = []
    for (const [m, v] of views) {
      const entry = this.#entryIds.get(m)
      if (!entry) continue
      if (v.kind === "duplicate") {
        const of = this.#entryIds.get(v.of)
        if (of) stored.push({ entry, kind: "duplicate", text: v.text, of })
      } else stored.push({ entry, kind: "aged", text: v.text, epoch: v.epoch })
    }
    if (stored.length) this.store({ type: "context", views: stored })
  }

  entryId(m: Message): string | undefined {
    return this.#entryIds.get(m)
  }

  setEntryId(m: Message, id: string): void {
    this.#entryIds.set(m, id)
  }

  forgetEntry(m: Message): void {
    this.#entryIds.delete(m)
  }

  compactionInfo(m: Message): CompactionInfo | undefined {
    return this.#compactions.get(m)
  }

  noteCompaction(summary: Message, info: CompactionInfo | undefined, originals?: Message[]): void {
    if (info) this.#compactions.set(summary, info)
    if (originals) this.#compacted.set(summary, originals)
  }

  /** The history a checkpoint's summary message stands for, if it can still be found. */
  originalsOf(m: Message): Message[] | undefined {
    const known = this.#compacted.get(m)
    if (known) return known
    const id = this.#entryIds.get(m)
    return (id ? this.#deps.session?.compacted(id) : undefined) ?? this.#deps.originals?.(m)
  }

  project(): Message[] {
    return projectMessages(this.messages, this.views)
  }
}
