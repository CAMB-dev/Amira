import { createHash } from "node:crypto"
import type { Usage } from "@amira/ai"
import { transferUsageAccounting } from "@amira/ai/accounting"
import { copyAccountingUsage, entryAccounting, identifyAccountingReceipt } from "./accounting-receipts.ts"
import type { Agent } from "./agent.ts"
import { type SessionEntry, SessionStore } from "./session-store.ts"
import { entryUsage, type UsageAttribution, type UsageReceipt } from "./session-usage.ts"

export interface ReceiptEvidence extends UsageReceipt {
  receiptId?: string
  attribution?: UsageAttribution
  durable: boolean
  revision: number
}
interface RetainedReceipt {
  receipt: ReceiptEvidence
  /** Financial projection only: never retain the containing assistant message. */
  settled?: ReceiptEvidence
  confirmed?: boolean
  conflict?: boolean
}
interface Destination {
  receipts: Map<string, RetainedReceipt>
  delivered: Set<string>
}

// SessionStore.file is already canonical. Do not resolve paths while handling a failing disk.
// Include immutable header identity so reusing a pathname cannot import another session's spend.
const files = new Map<string, Destination>()
const memory = new WeakMap<Agent, Destination>()
declare const receiptDestination: unique symbol
/** A canonical file/header key, with no reference to its writer or transcript. */
export type ReceiptDestination = string & { readonly [receiptDestination]: true }

export function usageReceiptDestination(store: SessionStore): ReceiptDestination {
  return fileKey(store) as ReceiptDestination
}

function fileKey(store: SessionStore): string {
  const file = process.platform === "win32" ? store.file.toLowerCase() : store.file
  return createHash("sha256")
    .update(JSON.stringify([file, store.header]))
    .digest("hex")
}
function destination(store: SessionStore | undefined, agent?: Agent, create = true): Destination | undefined {
  const key = store ? fileKey(store) : agent
  if (!key) return undefined
  const found = typeof key === "string" ? files.get(key) : memory.get(key)
  if (found || !create) return found
  const created: Destination = { receipts: new Map(), delivered: new Set() }
  if (typeof key === "string") files.set(key, created)
  else memory.set(key, created)
  return created
}

/** Capture one physical contribution, without assigning identity to a reusable provider object. */
export function identifiedUsage(usage: Usage): Usage {
  const copy = copyAccountingUsage(usage)
  identifyAccountingReceipt(copy, entryAccounting(usage).receiptId ?? crypto.randomUUID())
  return copy
}

function fromEntry(entry: SessionEntry, durable: boolean): ReceiptEvidence | undefined {
  const usage = entryUsage(entry)
  if (!usage) return undefined
  const receiptId = entry.accounting?.receiptId
  if (receiptId !== undefined && typeof receiptId !== "string")
    throw new Error("Invalid accounting receipt identity")
  return {
    usage,
    ...entry.accounting,
    ...(entry.type === "side_usage" && entry.attribution ? { attribution: entry.attribution } : {}),
    durable,
    revision: receiptId ? 2 : 1,
  }
}
function signature(receipt: ReceiptEvidence): string {
  const attribution = receipt.attribution
  return JSON.stringify([
    Object.entries(receipt.usage)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
    receipt.knownCostUsd ?? receipt.usage.cost ?? 0,
    !!receipt.coverageIncomplete,
    receipt.coverage,
    receipt.seal,
    receipt.source,
    receipt.attempts,
    receipt.statements,
    attribution && [
      attribution.sessionId,
      attribution.parentSessionId,
      attribution.groupId,
      attribution.ephemeral,
    ],
  ])
}

export function retainUsageReceipt(
  agent: Agent,
  store: SessionStore | undefined,
  usage: Usage,
  attribution?: UsageAttribution,
): void {
  const accounting = entryAccounting(usage)
  if (!accounting.receiptId) throw new Error("Accounting receipt identity is required")
  const state = destination(store, agent)!
  const snapshot = { ...usage }
  transferUsageAccounting(usage, snapshot)
  const receipt: ReceiptEvidence = {
    usage: snapshot,
    ...accounting,
    ...(attribution ? { attribution } : {}),
    durable: false,
    revision: 1,
  }
  const previous = state.receipts.get(accounting.receiptId)
  if (!previous) state.receipts.set(accounting.receiptId, { receipt })
  else if (signature(previous.receipt) !== signature(receipt)) previous.conflict = true
}

function reconcile(fresh: SessionStore | undefined, state: Destination): boolean {
  for (const retained of state.receipts.values()) retained.confirmed = false
  // A captured writer may be stale. Only current disk evidence can certify persistence.
  for (const entry of fresh?.entries ?? []) {
    const id = entry.accounting?.receiptId
    const retained = id ? state.receipts.get(id) : undefined
    if (!retained) continue
    const receipt = fromEntry(entry, true)
    if (!receipt || signature(receipt) !== signature(retained.receipt)) retained.conflict = true
    else {
      retained.settled = receipt
      retained.confirmed = fresh!.accountingDurable
    }
  }
  return fresh?.accountingDurable ?? false
}

/** Read-only union of durable rows and retained pending/settled receipts across writer views. */
export function usageReceiptEvidence(
  store: SessionStore | undefined,
  agent?: Agent,
  identity?: ReceiptDestination,
): {
  receipts: ReceiptEvidence[]
  intact: boolean
  entries: readonly SessionEntry[]
  currentStore?: SessionStore
} {
  // A replacement file must not redirect a finished child's retained receipts.
  if (identity && store && fileKey(store) !== identity) store = undefined
  const state = identity ? files.get(identity) : destination(store, agent, false)
  const fresh = store ? freshStore(store) : undefined
  const reconciled = state ? reconcile(fresh, state) : !!fresh?.accountingDurable
  const current = new Map(fresh?.entries.map((entry) => [entry.id, entry]))
  const currentReceipts = new Map(
    fresh?.entries
      .filter((entry) => entry.accounting?.receiptId)
      .map((entry) => [entry.accounting!.receiptId!, entry]),
  )
  const combined = new Map(store?.entries.map((entry) => [entry.id, entry]))
  for (const [key, entry] of current) if (!combined.has(key)) combined.set(key, entry)
  const receipts: ReceiptEvidence[] = []
  const identified = new Map<string, ReceiptEvidence>()
  const entries = new Set<string>()
  let intact = (store?.accountingDurable ?? false) && reconciled
  for (const entry of combined.values()) {
    if (entries.has(entry.id)) {
      intact = false
      continue
    }
    entries.add(entry.id)
    const receipt = fromEntry(entry, !!store?.accountingDurable && !!fresh?.accountingDurable)
    if (!receipt) continue
    const persisted =
      current.get(entry.id) ?? (receipt.receiptId ? currentReceipts.get(receipt.receiptId) : undefined)
    const persistedReceipt = persisted && fromEntry(persisted, true)
    receipt.durable &&= !!persistedReceipt && signature(receipt) === signature(persistedReceipt)
    const previous = receipt.receiptId ? identified.get(receipt.receiptId) : undefined
    if (previous) {
      if (signature(previous) !== signature(receipt)) previous.coverageIncomplete = true
      continue
    }
    receipts.push(receipt)
    if (receipt.receiptId) identified.set(receipt.receiptId, receipt)
  }
  for (const [id, retained] of state?.receipts ?? []) {
    const previous = identified.get(id)
    if (previous) {
      previous.durable &&= !!retained.confirmed
      if (retained.conflict || signature(previous) !== signature(retained.receipt)) {
        // Conflicting disk evidence cannot replace a captured reported contribution with zero
        // (or move it to another child). Preserve that contribution, but never certify it.
        Object.assign(previous, retained.receipt, { coverageIncomplete: true, durable: false })
      }
      continue
    }
    const receipt = retained.settled ?? retained.receipt
    if (!receipt) continue
    receipts.push({
      ...receipt,
      ...(retained.conflict ? { coverageIncomplete: true } : {}),
      durable: !!retained.confirmed,
      revision: retained.settled ? 2 : 1,
    })
  }
  return { receipts, intact, entries: fresh?.entries ?? store?.entries ?? [], currentStore: fresh }
}

/** Claim delivery before charging the tree; replacement observers share the same destination. */
export function claimNativeReceipt(agent: Agent, store: SessionStore | undefined, id: string): boolean {
  const state = destination(store, agent)!
  if (state.delivered.has(id)) return false
  state.delivered.add(id)
  if (state.receipts.has(id)) return false
  // A receipt may have been retained by another host writer without this observer.
  return !hasDurableReceipt(store, id)
}

export function hasDurableReceipt(store: SessionStore | undefined, id: string): boolean {
  return (
    !!store &&
    [store, freshStore(store)].some((view) =>
      view?.entries.some((entry) => entry.accounting?.receiptId === id),
    )
  )
}

function freshStore(store: SessionStore): SessionStore | undefined {
  try {
    const fresh = SessionStore.open(store.file, { historical: true })
    return fileKey(fresh) === fileKey(store) ? fresh : undefined
  } catch {
    return undefined
  }
}
