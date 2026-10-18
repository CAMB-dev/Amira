import type { Message, ModelRef, Signature, Usage } from "@amira/ai"
import type { CompactionInfo, NoticeLevel, PrintOptions } from "@amira/api"
import type { UsageCoverage } from "./accounting-coverage.ts"
import type { ContextView, StoredView } from "./context.ts"
import type { FileJournalEntry } from "./file-rewind.ts"
import type { UsageAttribution } from "./session-usage.ts"
import type { AccountingStatement } from "./usage-statements.ts"

export type SessionEntryData =
  | FileJournalEntry
  | { type: "title"; title: string; source: "manual" | "auto" }
  /** `label` says what the side request was for; entries without one are session titles. */
  | { type: "side_usage"; model: ModelRef; usage: Usage; label?: string; attribution?: UsageAttribution }
  /** Display-only transcript content, skipped when restoring the model conversation. */
  | ({ type: "display"; text: string; level: NoticeLevel } & Omit<PrintOptions, "persist">)
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
  | { type: "subagent"; childSessionId: string; role: string; title?: string; groupId?: string }
  /** Deferred tools the session loaded (via tool_search), offered to the model from then on. */
  | { type: "tools_loaded"; names: string[] }
  | { type: "custom"; ext: string; data: unknown }
  /**
   * How earlier tool results are sent from now on (context management): each view replaces
   * one result's content in requests, the message itself stays whole. An Amira that does not
   * know this entry type sends the results whole.
   */
  | { type: "context"; views: StoredView[] }

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

export type SessionEntry = SessionEntryData & {
  id: string
  parentId: string | null
  ts: number
  /** Serializable subtotal: an aggregate Usage may otherwise retain this only in a WeakMap. */
  accounting?: {
    knownCostUsd?: number
    incomplete?: true
    coverageIncomplete?: true
    receiptId?: string
    coverage?: UsageCoverage
    source?: "request" | "reported" | "unknown"
    attempts?: { id: string; revision: number }[]
    statements?: AccountingStatement[]
    seal?: string
    journal?: { v: 1; sessionId: string; fingerprint: string }
  }
}

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
  /** How tool results on this branch are sent (context entries), by message. */
  views: Map<Message, ContextView>
}
