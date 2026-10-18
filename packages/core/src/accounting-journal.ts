import { createHash } from "node:crypto"
import type { CoveredReceipt } from "./accounting-coverage.ts"
import type { SessionEntry, SessionEntryData } from "./session-store.ts"

export const REFERENCE_PROOFS = "amira.accounting-references"
export function noteEntry(entry: SessionEntryData): boolean {
  return entry.type === "custom" && ["amira.accounting-requests", REFERENCE_PROOFS].includes(entry.ext)
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex")
}

/** Bind the positive witness to all accounting facts, not just a potentially editable boolean. */
export function receiptSeal(receipt: CoveredReceipt): string {
  return digest([
    receipt.usage,
    receipt.knownCostUsd,
    receipt.receiptId,
    receipt.source,
    receipt.coverage,
    receipt.coverageIncomplete ?? false,
    receipt.attempts ?? null,
    receipt.statements ?? null,
  ])
}

export function referenceProof(entry: SessionEntry, parentSessionId: string) {
  if (entry.type !== "subagent") return undefined
  const facts = {
    v: 1,
    markerId: entry.id,
    parentSessionId,
    childSessionId: entry.childSessionId,
    role: entry.role,
    title: entry.title ?? null,
    groupId: entry.groupId ?? null,
    ts: entry.ts,
  }
  return { ...facts, fingerprint: digest(facts) }
}

/** A removed marker leaves an orphan proof; a removed proof leaves an unverified marker. */
export function appendReferenceProof(
  entry: SessionEntry,
  parentSessionId: string,
  append: (data: SessionEntryData) => string,
): void {
  const data = referenceProof(entry, parentSessionId)
  if (data) append({ type: "custom", ext: REFERENCE_PROOFS, data })
}

function journalFingerprint(entry: SessionEntry, sessionId: string): string {
  const { journal: _journal, ...accounting } = entry.accounting ?? {}
  return digest([sessionId, { ...entry, accounting }])
}

export function sealJournalEntry(entry: SessionEntry, sessionId: string): void {
  entry.accounting = {
    ...entry.accounting,
    journal: {
      v: 1,
      sessionId,
      fingerprint: journalFingerprint(entry, sessionId),
    },
  }
}

export function validJournalEntry(
  value: SessionEntry,
  supported: ReadonlySet<unknown>,
  sessionId: string,
): boolean {
  const structure =
    typeof value.id === "string" &&
    value.id.length > 0 &&
    supported.has(value.type) &&
    (value.parentId === null || (typeof value.parentId === "string" && value.parentId.length > 0)) &&
    typeof value.ts === "number" &&
    Number.isFinite(value.ts)
  const model = (ref: unknown) =>
    !!ref &&
    typeof ref === "object" &&
    typeof (ref as { provider?: unknown }).provider === "string" &&
    !!(ref as { provider: string }).provider &&
    typeof (ref as { model?: unknown }).model === "string" &&
    !!(ref as { model: string }).model
  if (value.type === "side_usage" && !model(value.model)) return false
  if (
    value.type === "message" &&
    (!value.message ||
      !Array.isArray(value.message.content) ||
      !["user", "assistant", "toolResult"].includes(value.message.role) ||
      (value.message.role === "assistant" && !model(value.message.model)))
  )
    return false
  if (
    !structure ||
    (value.type === "message" && value.message?.role === "assistant" && !value.message.usage) ||
    (value.type === "compaction" && !value.usage && (value.model !== undefined || value.native !== undefined))
  )
    return false
  const proof = value.accounting?.journal
  if (!proof)
    return (
      value.type !== "side_usage" &&
      value.type !== "subagent" &&
      !(value.type === "message" && value.message?.role === "assistant") &&
      !(value.type === "compaction" && value.usage) &&
      !noteEntry(value)
    )
  return (
    proof.v === 1 &&
    proof.sessionId === sessionId &&
    proof.fingerprint === journalFingerprint(value, sessionId)
  )
}
