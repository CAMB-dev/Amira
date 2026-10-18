import { addUsage, emptyUsage, type Usage } from "@amira/ai"
import { knownUsageCost } from "@amira/ai/accounting"
import type { AccountedUsage } from "@amira/api"
import {
  type CoverageRequirement,
  type CoveredReceipt,
  completeAccounting,
  representableAccounting,
  requestCoverage,
  resolveAccounting,
} from "./accounting-coverage.ts"
import type { SessionEntryData, SessionStore } from "./session-store.ts"

/** Minimal attribution for a private receipt; never contains a prompt or transcript. */
export interface UsageAttribution {
  sessionId: string
  parentSessionId: string
  groupId?: string
  ephemeral?: boolean
}

export function entryUsage(entry: SessionEntryData): Usage | undefined {
  if (entry.type === "message") return entry.message.role === "assistant" ? entry.message.usage : undefined
  if (entry.type === "side_usage" || entry.type === "compaction") {
    const financial =
      "accounting" in entry
        ? (entry.accounting as { knownCostUsd?: number; receiptId?: string } | undefined)
        : undefined
    if (
      !entry.usage &&
      (entry.type === "side_usage" ||
        financial?.knownCostUsd !== undefined ||
        financial?.receiptId !== undefined)
    )
      throw new Error("Invalid accounting receipt: usage is missing")
    return entry.usage
  }
  return undefined
}

export type UsageReceipt = CoveredReceipt

/** Shared by historical listings and owned snapshots: every attempt, on every branch. */
export function accountUsage(
  records: readonly UsageReceipt[],
  evidence: boolean | readonly CoverageRequirement[] = false,
): AccountedUsage {
  const resolved = resolveAccounting(records)
  const receipts = resolved.receipts
  let usage = emptyUsage()
  let knownCostUsd = 0
  let estimated = 0
  for (const receipt of receipts) {
    const row = receipt.usage
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (!Number.isFinite(row[key])) throw new Error("Invalid accounting usage counters")
    }
    if (receipt.knownCostUsd !== undefined && !Number.isFinite(receipt.knownCostUsd))
      throw new Error("Invalid accounting known subtotal")
    for (const key of ["cost", "webSearchCost", "webSearchRequests"] as const) {
      if (row[key] !== undefined && !Number.isFinite(row[key]))
        throw new Error("Invalid accounting price or search usage")
    }
    if (row.pricingUnknown)
      estimated += Math.sign(row.input + row.output + row.cacheRead + row.cacheWrite + (row.cost ?? 0)) || 1
    usage = addUsage(usage, row)
    knownCostUsd += receipt.knownCostUsd ?? knownUsageCost(row) ?? 0
  }
  if (!representableAccounting(receipts))
    throw new Error("Invalid accounting aggregate: totals are not finite")
  if (estimated <= 0) delete usage.pricingUnknown
  else usage.pricingUnknown = true
  const requirements: readonly CoverageRequirement[] =
    typeof evidence === "boolean" ? [{ kind: "integrity", verified: evidence }] : evidence
  const complete = completeAccounting(receipts, [...requirements, ...resolved.requirements], records)
  if (complete && receipts.length) usage.cost = knownCostUsd
  return { usage, knownCostUsd, complete }
}

export function storedUsageReceipts(store: SessionStore): UsageReceipt[] {
  return store.entries.flatMap((entry) => {
    const usage = entryUsage(entry)
    return usage ? [{ usage, ...entry.accounting, durable: store.accountingDurable }] : []
  })
}

export function storedSessionUsage(store: SessionStore): AccountedUsage {
  return accountUsage(storedUsageReceipts(store), [
    { kind: "integrity", verified: store.accountingDurable },
    ...requestCoverage(store.entries),
  ])
}
