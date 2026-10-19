import type { ModelRef, Signature } from "@amira/ai"
import type { CompactionInfo, CompactionReason } from "@amira/api"
import type { SessionEntry } from "./session-entry.ts"

export function parseLine(line: string): unknown {
  if (!line.trim()) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

const REASONS = new Set<unknown>(["threshold", "manual", "overflow"] satisfies CompactionReason[])

/** What a compaction entry says about why it happened; undefined for entries without it. */
export function compactionInfo(e: Partial<CompactionInfo>): CompactionInfo | undefined {
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
export function checkpointIn(v: unknown): Signature | undefined {
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

export const ENTRY_TYPES = new Set<unknown>([
  "file_mutation",
  "file_mutation_end",
  "file_restore",
  "file_restore_started",
  "file_restore_progress",
  "file_restore_end",
  "file_prune",
  "title",
  "side_usage",
  "display",
  "message",
  "model_change",
  "compaction",
  "checkout",
  "subagent",
  "tools_loaded",
  "custom",
  "context",
])

export function isEntry(v: unknown): v is SessionEntry {
  const e = v as { id?: unknown; type?: unknown } | undefined
  return typeof e?.id === "string" && ENTRY_TYPES.has(e.type)
}
