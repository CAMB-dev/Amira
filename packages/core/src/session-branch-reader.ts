import type { SessionEntry } from "./session-entry.ts"
import type { SessionStore } from "./session-store.ts"

type BranchLinks = {
  leaf(): string | null
  entry(id: string): SessionEntry | undefined
  previous(id: string): string | null | undefined
}
const branches = new WeakMap<SessionStore, BranchLinks>()

/** Host-only access to retained links, not a cloned/materialized public history. */
export function registerSessionBranchReader(store: SessionStore, links: BranchLinks): void {
  branches.set(store, links)
}

/** Reverse chronological, lazy, with the same damaged-parent bridging as SessionStore.branch(). */
export function* sessionBranchEntries(store: SessionStore): Generator<SessionEntry> {
  const links = branches.get(store)
  if (!links) throw new Error("Session branch reader is unavailable")
  const seen = new Set<string>()
  for (let id = links.leaf(); id && !seen.has(id); ) {
    if (seen.size >= 100_000) throw new Error("Conversation history exceeds the entry limit")
    seen.add(id)
    const entry = links.entry(id)
    if (!entry) break
    yield entry
    id = entry.parentId && !links.entry(entry.parentId) ? (links.previous(entry.id) ?? null) : entry.parentId
  }
}
