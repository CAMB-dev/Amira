import { addUsage, type Usage } from "@amira/ai"
import { isUsageAggregate, knownUsageCost, transferUsageAccounting } from "@amira/ai/accounting"
import { type UsageCoverage, usageCoverage } from "./accounting-coverage.ts"
import { receiptSeal } from "./accounting-journal.ts"

export { appendReferenceProof, noteEntry, sealJournalEntry, validJournalEntry } from "./accounting-journal.ts"

import { type AccountingStatement, statementOf } from "./usage-statements.ts"

/** Physical attempts, not equal token counters, identify the charges a request must retain. */
export interface AccountingAttempt {
  id: string
  receipts: Set<string>
  revision: number
  recorded: number
  reported: boolean
  covered: boolean
}

const attempts = new WeakMap<Usage, Map<AccountingAttempt, number>>()
const incomplete = new WeakSet<Usage>()
const identities = new WeakMap<Usage, string>()
const writes = new WeakMap<Usage, string>()
const reported = new WeakSet<Usage>()

/** Explicit external receipt (for example a late native callback), never an inferred fallback. */
export function reportedUsage(usage: Usage, id?: string): Usage {
  const copy = copyAccountingUsage(usage)
  if (id !== undefined) identifyAccountingReceipt(copy, id)
  reported.add(copy)
  return copy
}
const committed = new WeakMap<Usage, string>()
const inheritedStatements = new WeakMap<Usage, Map<string, AccountingStatement>>()

/** Acknowledgement is tied to a successful append, never merely to observing an event. */
export function commitWrite(usage: Usage, entryId: string): string {
  const id = identities.get(usage) ?? writes.get(usage)
  if (id) committed.set(usage, id)
  return entryId
}

/** One write view's successful appends, matched once to subsequent tree charges. */
export class UsageWriteEvidence {
  #written = new WeakMap<Usage, string>()
  #accounted = new Set<string>()
  commit(usage: Usage, entryId: string): void {
    this.#written.set(usage, commitWrite(usage, entryId))
  }
  take(usage: Usage): boolean {
    const id = this.#written.get(usage)
    if (!id || this.#accounted.has(id)) return false
    this.#accounted.add(id)
    return true
  }
}

export function usageStatements(usage: Usage): AccountingStatement[] {
  const local = statementOf(usage)
  if (local) return [{ ...local, attempts: accountingBindings(usage) }]
  return [...(inheritedStatements.get(usage)?.values() ?? [])]
}

function accountingBindings(usage: Usage): { id: string; revision: number }[] {
  return [...(attempts.get(usage) ?? [])].map(([attempt, revision]) => ({ id: attempt.id, revision }))
}

export function retainReportedUsage(target: Usage, source: Usage): void {
  if (reported.has(source)) reported.add(target)
}

/** Give every first write an identity, even when bytes land before append() throws. */
export function prepareAccountingWrite(usage: Usage): void {
  if (!identities.has(usage)) writes.set(usage, crypto.randomUUID())
}

/** Bind a late physical receipt to the same durable row as its charge. */
export function identifyAccountingReceipt(usage: Usage, id: string): void {
  identities.set(usage, id)
}

export function accountingAttempt(): AccountingAttempt {
  return {
    id: crypto.randomUUID(),
    receipts: new Set(),
    revision: 0,
    recorded: 0,
    reported: false,
    covered: false,
  }
}

export function observeAccountingAttempt(attempt: AccountingAttempt, usage: Usage | undefined): void {
  attempt.revision++
  const coverage = usageCoverage(usage)
  attempt.reported = coverage.reported
  attempt.covered = coverage.reported && coverage.priced
  if (usage) attempts.set(usage, new Map([[attempt, attempt.revision]]))
}

/** Carry exact attempt revisions through summary aggregation, without broad agent-wide settlement. */
export function retainAccountingReceipts(total: Usage, source: Usage): void {
  const receipts = attempts.get(source)
  if (receipts) {
    const retained = attempts.get(total) ?? new Map<AccountingAttempt, number>()
    for (const [attempt, revision] of receipts)
      retained.set(attempt, Math.max(retained.get(attempt) ?? 0, revision))
    attempts.set(total, retained)
  }
  if (incomplete.has(source)) incomplete.add(total)
  const snapshots = usageStatements(source)
  if (snapshots.length) {
    const retained = inheritedStatements.get(total) ?? new Map<string, AccountingStatement>()
    for (const snapshot of snapshots)
      retained.set(`${snapshot.id}:${snapshot.revision}:${snapshot.kind}`, snapshot)
    inheritedStatements.set(total, retained)
  }
}

/** Bind collected physical native receipts to the containing durable host request. */
export function bindUsageStatements(usage: Usage): void {
  const bindings = accountingBindings(usage)
  const statements = usageStatements(usage).map((statement) => ({ ...statement, attempts: bindings }))
  inheritedStatements.set(
    usage,
    new Map(
      statements.map((statement) => [`${statement.id}:${statement.revision}:${statement.kind}`, statement]),
    ),
  )
}

/** Sparse optional reporting cannot refund prior amounts; explicit aggregate subtotals can replace them. */
export function usageSnapshot(usage: Usage, previous?: Usage): Usage {
  const snapshot = copyAccountingUsage(usage)
  if (previous && !(isUsageAggregate(usage) && knownUsageCost(usage) !== undefined)) {
    let omitted = false
    for (const key of ["reasoning", "webSearchRequests", "webSearchCost", "cost"] as const) {
      const known = key === "cost" ? (previous.cost ?? knownUsageCost(previous)) : previous[key]
      if (snapshot[key] === undefined && known !== undefined) {
        snapshot[key] = known
        omitted = true
      }
    }
    if (omitted) snapshot.pricingUnknown = true
  }
  return snapshot
}

/** Copy provider-owned counters without dropping hidden known prices or attempt coverage. */
export function copyAccountingUsage(usage: Usage): Usage {
  const copy = { ...usage }
  transferUsageAccounting(usage, copy)
  retainAccountingReceipts(copy, usage)
  if (reported.has(usage)) reported.add(copy)
  return copy
}

export function addAccountingUsage(left: Usage, right: Usage): Usage {
  const total = addUsage(left, right)
  retainAccountingReceipts(total, left)
  retainAccountingReceipts(total, right)
  return total
}

export function recordAccountingReceipts(usage: Usage): void {
  const id = committed.get(usage)
  if (!id || id !== (identities.get(usage) ?? writes.get(usage))) return
  for (const [attempt, revision] of attempts.get(usage) ?? []) {
    attempt.receipts.add(id)
    if (statementOf(usage)?.kind !== "credit") attempt.recorded = Math.max(attempt.recorded, revision)
  }
}

/** Aggregate coverage is independent of its known subtotal and must survive serialization. */
export function markAccountingIncomplete(usage: Usage): void {
  incomplete.add(usage)
}

export function accountingIncomplete(usage: Usage): boolean {
  return incomplete.has(usage)
}

export function entryAccounting(usage: Usage): {
  knownCostUsd: number
  coverageIncomplete?: true
  receiptId?: string
  coverage: UsageCoverage
  source: "request" | "reported" | "unknown"
  attempts?: { id: string; revision: number }[]
  statements?: AccountingStatement[]
  seal: string
} {
  const receiptId = identities.get(usage) ?? writes.get(usage)
  const coverage = usageCoverage(usage, knownUsageCost(usage) ?? 0, accountingIncomplete(usage))
  const bound = accountingBindings(usage)
  const statements = usageStatements(usage)
  const evidence: Omit<ReturnType<typeof entryAccounting>, "seal"> = {
    knownCostUsd: knownUsageCost(usage) ?? 0,
    coverage,
    source: bound.length ? "request" : reported.has(usage) ? "reported" : "unknown",
    ...(bound.length ? { attempts: bound } : {}),
    ...(statements.length ? { statements } : {}),
    ...(receiptId ? { receiptId } : {}),
    ...(accountingIncomplete(usage) ? { coverageIncomplete: true } : {}),
  }
  return { ...evidence, seal: receiptSeal({ usage, ...evidence }) }
}

export function incompleteUsage(usage: Usage): boolean {
  return (
    usage.outputReported === false ||
    (usage.cost === undefined &&
      [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.webSearchRequests ?? 0].some(
        (amount) => amount !== 0,
      ))
  )
}
