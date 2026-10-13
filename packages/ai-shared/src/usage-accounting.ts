import type { UsageCounts } from "./index.ts"

interface UsageAccounting {
  readonly knownCost: number | undefined
  readonly knownSearchCost: number | undefined
  readonly unpricedSearchRequests: number
}

interface StoredAccounting extends UsageAccounting {
  readonly visibleCost: number | undefined
  readonly visibleSearchCost: number | undefined
  readonly visibleSearchRequests: number | undefined
}

// Only aggregate results (and explicit mutable copies) carry this constant-size state.
// Nothing is attached to usage objects or retained by request id; keys can be collected.
const accounting = new WeakMap<UsageCounts, StoredAccounting>()

function readAccounting(usage: UsageCounts): UsageAccounting {
  const stored = accounting.get(usage)
  if (
    stored &&
    stored.visibleCost === usage.cost &&
    stored.visibleSearchCost === usage.webSearchCost &&
    stored.visibleSearchRequests === usage.webSearchRequests
  )
    return stored
  // Public usage objects remain editable; a changed price is a new raw contribution.
  return {
    knownCost: usage.cost,
    knownSearchCost: usage.webSearchCost,
    unpricedSearchRequests: usage.webSearchCost === undefined ? (usage.webSearchRequests ?? 0) : 0,
  }
}

function retain(usage: UsageCounts, state: UsageAccounting): void {
  accounting.set(
    usage,
    Object.freeze({
      ...state,
      visibleCost: usage.cost,
      visibleSearchCost: usage.webSearchCost,
      visibleSearchRequests: usage.webSearchRequests,
    }),
  )
}

function subtotal(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/** Internal to addUsage: retain known subtotals independently of displayed prices. */
export function sumUsageAccounting(a: UsageCounts, b: UsageCounts, sum: UsageCounts): void {
  const left = readAccounting(a)
  const right = readAccounting(b)
  const state: UsageAccounting = Object.freeze({
    knownCost: subtotal(left.knownCost, right.knownCost),
    knownSearchCost: subtotal(left.knownSearchCost, right.knownSearchCost),
    unpricedSearchRequests: left.unpricedSearchRequests + right.unpricedSearchRequests,
  })
  if (state.unpricedSearchRequests <= 0) {
    if (state.knownCost !== undefined) sum.cost = state.knownCost
    if (state.knownSearchCost !== undefined) sum.webSearchCost = state.knownSearchCost
  }
  retain(sum, state)
}

/** Known USD subtotal, even when an unresolved search makes the displayed total unknown. */
export function knownUsageCost(usage: UsageCounts): number | undefined {
  return readAccounting(usage).knownCost
}

/** Call after copying numeric fields into a mutable aggregate; Object.assign loses private state. */
export function transferUsageAccounting(from: UsageCounts, to: UsageCounts): void {
  retain(to, readAccounting(from))
}
