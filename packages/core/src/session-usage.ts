import { addUsage, emptyUsage, type Usage } from "@amira/ai"
import {
  hasUnpricedUsage,
  isUsageAggregate,
  knownUsageCost,
  transferUsageAccounting,
} from "@amira/ai/accounting"
import type { AccountedUsage, Budget } from "@amira/api"
import type { Agent } from "./agent.ts"
import type { SessionEntry, SessionEntryData, SessionStore } from "./session-store.ts"

/** Minimal attribution for a private receipt; never contains a prompt or transcript. */
export interface UsageAttribution {
  sessionId: string
  parentSessionId: string
  groupId?: string
  ephemeral?: boolean
}

const persistedKnownCost = new WeakMap<Usage, number>()

export function cloneUsage(usage: Usage): Usage {
  const copy: Usage = { ...usage }
  transferUsageAccounting(usage, copy)
  const extra = persistedKnownCost.get(usage)
  if (extra !== undefined) persistedKnownCost.set(copy, extra)
  return copy
}

export function entryUsage(entry: SessionEntry | SessionEntryData): Usage | undefined {
  const usage =
    entry.type === "message"
      ? entry.message.role === "assistant"
        ? entry.message.usage
        : undefined
      : entry.type === "side_usage" || entry.type === "compaction"
        ? entry.usage
        : undefined
  const knownCost =
    "accounting" in entry
      ? (entry.accounting as { knownCostUsd?: number } | undefined)?.knownCostUsd
      : undefined
  if (usage && usage.cost === undefined && knownUsageCost(usage) === undefined && knownCost !== undefined) {
    persistedKnownCost.set(usage, knownCost)
  }
  return usage
}

export function incompleteUsage(usage: Usage): boolean {
  return usage.outputReported === false || usage.pricingUnknown === true || hasUnpricedUsage(usage)
}

export function isZeroUsage(usage: Usage): boolean {
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    (usage.webSearchRequests ?? 0) === 0
  )
}

export function addAccountingUsage(a: Usage, b: Usage): Usage {
  const sum = addUsage(a, b)
  if (a.outputReported === false || b.outputReported === false) sum.outputReported = false
  if (a.pricingUnknown || b.pricingUnknown) sum.pricingUnknown = true
  return sum
}

/** Negates a usage snapshot so `addUsage(total, neg)` reverses an earlier observation. */
export function negateUsage(previous: Usage): Usage {
  const neg: Usage = {
    input: -previous.input,
    output: -previous.output,
    cacheRead: -previous.cacheRead,
    cacheWrite: -previous.cacheWrite,
    ...(previous.reasoning !== undefined ? { reasoning: -previous.reasoning } : {}),
    ...(previous.cost !== undefined ? { cost: -previous.cost } : {}),
    ...(previous.webSearchRequests !== undefined ? { webSearchRequests: -previous.webSearchRequests } : {}),
    ...(previous.webSearchCost !== undefined ? { webSearchCost: -previous.webSearchCost } : {}),
  }
  transferUsageAccounting(previous, neg, -1)
  return neg
}

/** Computes the difference between two snapshots for delta-based accounting. */
export function usageDelta(next: Usage, previous: Usage): Usage {
  return addUsage(next, negateUsage(previous))
}

/** Keeps the most complete usage snapshot seen during a single streaming attempt. */
export function usageSnapshot(next: Usage, previous?: Usage): Usage {
  if (!previous) return cloneUsage(next)
  const nextUnpriced = isUsageAggregate(next) && hasUnpricedUsage(next)
  const merged: Usage = {
    ...previous,
    ...next,
    input: Math.max(previous.input, next.input),
    output: Math.max(previous.output, next.output),
    cacheRead: Math.max(previous.cacheRead, next.cacheRead),
    cacheWrite: Math.max(previous.cacheWrite, next.cacheWrite),
  }
  if (nextUnpriced) {
    if (next.cost === undefined) delete merged.cost
    if (next.webSearchCost === undefined) delete merged.webSearchCost
  } else {
    if (next.cost === undefined && previous.cost !== undefined) merged.cost = previous.cost
    if (next.webSearchCost === undefined && previous.webSearchCost !== undefined)
      merged.webSearchCost = previous.webSearchCost
  }
  if (next.webSearchRequests === undefined && previous.webSearchRequests !== undefined)
    merged.webSearchRequests = previous.webSearchRequests
  if (next.reasoning === undefined && previous.reasoning !== undefined) merged.reasoning = previous.reasoning
  const omittedMetadata =
    (!nextUnpriced && previous.cost !== undefined && next.cost === undefined) ||
    (previous.webSearchRequests !== undefined && next.webSearchRequests === undefined)
  if (next.outputReported === false || previous.outputReported === false) {
    if (next.outputReported === false) merged.outputReported = false
    else if (next.outputReported === true) delete merged.outputReported
    else merged.outputReported = false
  }
  const nextKnown = knownUsageCost(next)
  const prevKnown = knownUsageCost(previous)
  if (nextUnpriced || (nextKnown !== undefined && merged.cost === undefined))
    transferUsageAccounting(next, merged)
  else if (prevKnown !== undefined && merged.cost === undefined) transferUsageAccounting(previous, merged)
  if (omittedMetadata || nextUnpriced || next.pricingUnknown || previous.pricingUnknown)
    merged.pricingUnknown = true
  return merged
}

/** Shared by historical listings and owned snapshots: every attempt, on every branch. */
export function accountUsage(records: readonly Usage[], durable = true): AccountedUsage {
  let usage = emptyUsage()
  let knownCostUsd = 0
  let complete = durable
  for (const row of records) {
    usage = addUsage(usage, row)
    knownCostUsd += knownUsageCost(row) ?? persistedKnownCost.get(row) ?? row.cost ?? 0
    if (incompleteUsage(row) || (row.cost === undefined && !isZeroUsage(row))) complete = false
  }
  if (complete && records.length) usage.cost = knownCostUsd
  return { usage, knownCostUsd, complete }
}

export function storedSessionUsage(store: SessionStore): AccountedUsage {
  const records = store.entries.flatMap((entry) => {
    const u = entryUsage(entry)
    return u ? [u] : []
  })
  return accountUsage(records, store.accountingDurable)
}

/** Emits a live budget update on the owning agent's bus. */
export function emitBudgetUpdate(owner: Agent, usage: Usage, limit?: Budget): void {
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  const costUsd = usage.cost ?? knownUsageCost(usage)
  const pricingUnknown = usage.pricingUnknown === true
  const meta = {
    sessionId: owner.sessionId,
    ...(owner.parentSessionId ? { parentSessionId: owner.parentSessionId } : {}),
  }
  owner.bus.emit(
    "budget.update",
    {
      tokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(pricingUnknown ? { pricingUnknown: true } : {}),
      ...(limit ? { limit } : {}),
    },
    meta,
  )
}
