import { accessSync, constants, statSync } from "node:fs"
import type { CoverageRequirement } from "./accounting-coverage.ts"
import { REFERENCE_PROOFS, referenceProof } from "./accounting-journal.ts"
import { SessionStore } from "./session-store.ts"
import { type SubagentEntry, subagentsOf } from "./subagent-list.ts"
import type { AgentTree } from "./subagents.ts"

/** Accounting uses the presentation traversal, but cannot treat a skipped reference as proof. */
export function accountingDescendants(
  sessionId: string,
  store: SessionStore | undefined,
  tree?: AgentTree,
): { entries: SubagentEntry[]; requirements: CoverageRequirement[] } {
  const requirements: CoverageRequirement[] = []
  const requireReference = (verified: boolean) => {
    requirements.push({ kind: "reference", verified })
  }
  const rootMatches = safeId(sessionId) && (!store || store.id === sessionId)
  requireReference(rootMatches)
  if (!rootMatches) return { entries: [], requirements }

  const listed = subagentsOf(sessionId, store, tree, true)
  const reachable = new Set([sessionId])
  const accepted = new Set<SubagentEntry>()
  // Normally depth first. A live tree may supply the real parent of an entry first encountered
  // through a conflicting persisted marker, so establish reachability independently of order.
  let advanced = true
  while (advanced) {
    advanced = false
    for (const entry of listed) {
      if (accepted.has(entry)) continue
      const { id, parentSessionId } = entry.info
      if (!safeId(id) || id === sessionId || !safeId(parentSessionId)) continue
      if (!reachable.has(parentSessionId)) continue
      if (entry.session && (entry.session.id !== id || entry.session.header.parent !== parentSessionId))
        continue
      accepted.add(entry)
      reachable.add(id)
      advanced = true
    }
  }
  // Do not hand a mismatched child's transcript (or its descendants) to the accounting reader.
  // A missing store can still identify an incomplete row, but never verifies the reference.
  const persisted = new Set(listed.filter((entry) => accepted.has(entry) && readableStore(entry.session)))
  for (const entry of listed) requireReference(persisted.has(entry))
  const entries = listed.filter((entry) => accepted.has(entry))
  const byId = new Map(entries.map((entry) => [entry.info.id, entry]))
  const claimed = new Set<string>([sessionId])
  const inspect = (parentId: string, evidence: SessionStore | undefined) => {
    if (evidence) {
      try {
        const current = SessionStore.open(evidence.file, { historical: true })
        if (JSON.stringify(current.header) === JSON.stringify(evidence.header)) evidence = current
        else requireReference(false)
      } catch {
        requireReference(false)
      }
    }
    const proofs =
      evidence?.entries.filter((entry) => entry.type === "custom" && entry.ext === REFERENCE_PROOFS) ?? []
    const markers = evidence?.entries.filter((entry) => entry.type === "subagent") ?? []
    for (const proof of proofs) {
      const data = proof.type === "custom" ? (proof.data as Record<string, unknown> | undefined) : undefined
      const marker = data && markers.find((entry) => entry.id === data.markerId)
      const expected = marker && referenceProof(marker, parentId)
      requireReference(
        !!expected &&
          data?.v === 1 &&
          data.parentSessionId === parentId &&
          data.childSessionId === expected.childSessionId &&
          data.fingerprint === expected.fingerprint,
      )
    }
    for (const marker of evidence?.entries ?? []) {
      if (marker.type !== "subagent") continue
      const id = marker.childSessionId
      const matches = proofs.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.data &&
          typeof entry.data === "object" &&
          (entry.data as Record<string, unknown>).markerId === marker.id,
      )
      const expected = referenceProof(marker, parentId)
      requireReference(
        matches.length === 1 &&
          expected?.fingerprint ===
            (matches[0]?.type === "custom"
              ? (matches[0].data as Record<string, unknown>)?.fingerprint
              : undefined) &&
          typeof marker.role === "string" &&
          (marker.title === undefined || typeof marker.title === "string") &&
          (marker.groupId === undefined || (typeof marker.groupId === "string" && marker.groupId.length > 0)),
      )
      if (!safeId(id) || claimed.has(id)) {
        // Includes duplicate markers, ancestor cycles and references to the owning root.
        requireReference(false)
        continue
      }
      claimed.add(id)
      const child = byId.get(id)
      requireReference(
        !!child &&
          persisted.has(child) &&
          child.info.parentSessionId === parentId &&
          child.info.groupId === marker.groupId,
      )
    }
  }
  inspect(sessionId, store)
  for (const entry of entries) inspect(entry.info.id, entry.session)
  return { entries, requirements }
}

function safeId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !/[^\w-]/.test(id)
}

function readableStore(store: SessionStore | undefined): boolean {
  if (!store) return false
  try {
    accessSync(store.file, constants.R_OK)
    return statSync(store.file).isFile()
  } catch {
    return false
  }
}
