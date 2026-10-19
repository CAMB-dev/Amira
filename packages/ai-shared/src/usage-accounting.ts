import type { UsageCounts } from "./index.ts"

export interface UsageReceipt {
  readonly aggregate: boolean
  readonly knownCost?: number
  readonly hasReportedCost: boolean
  readonly knownSearchCost?: number
  readonly unpricedSearchRequests: number
  readonly unpricedTokens: number
  readonly unknownContributions: number
  readonly unpricedContributions: number
  readonly unreportedContributions: number
}

type UsageAccounting = UsageReceipt

interface StoredAccounting extends UsageAccounting {
  readonly visibleCost: number | undefined
  readonly visibleSearchCost: number | undefined
  readonly visibleSearchRequests: number | undefined
  readonly visibleInput: number
  readonly visibleOutput: number
  readonly visibleCacheRead: number
  readonly visibleCacheWrite: number
  readonly visibleReasoning: number | undefined
  readonly visiblePricingUnknown: boolean | undefined
  readonly visibleOutputReported: boolean | undefined
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
    stored.visibleSearchRequests === usage.webSearchRequests &&
    stored.visibleInput === usage.input &&
    stored.visibleOutput === usage.output &&
    stored.visibleCacheRead === usage.cacheRead &&
    stored.visibleCacheWrite === usage.cacheWrite &&
    stored.visibleReasoning === usage.reasoning
  ) {
    if (
      stored.visiblePricingUnknown === usage.pricingUnknown &&
      stored.visibleOutputReported === usage.outputReported
    )
      return stored
    // Coverage metadata disappearing does not erase known money or resolve old gaps.
    // A new full contribution (or an explicit signed reversal) supplies replacement evidence.
    return {
      ...stored,
      unknownContributions:
        stored.unknownContributions +
        (usage.pricingUnknown === true && stored.visiblePricingUnknown !== true ? 1 : 0),
      unreportedContributions:
        stored.unreportedContributions +
        (usage.outputReported === false && stored.visibleOutputReported !== false ? 1 : 0),
    }
  }
  // Public usage objects remain editable; a changed price is a new raw contribution.
  return {
    aggregate: false,
    knownCost: usage.cost ?? usage.webSearchCost,
    hasReportedCost: usage.cost !== undefined,
    knownSearchCost: usage.webSearchCost,
    unpricedSearchRequests: usage.webSearchCost === undefined ? (usage.webSearchRequests ?? 0) : 0,
    unpricedTokens:
      usage.cost === undefined
        ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0)
        : 0,
    unknownContributions: usage.pricingUnknown ? 1 : 0,
    unpricedContributions:
      usage.cost === undefined &&
      [
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.reasoning ?? 0,
        usage.webSearchRequests ?? 0,
      ].some((amount) => amount !== 0)
        ? 1
        : 0,
    unreportedContributions: usage.outputReported === false ? 1 : 0,
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
      visibleInput: usage.input,
      visibleOutput: usage.output,
      visibleCacheRead: usage.cacheRead,
      visibleCacheWrite: usage.cacheWrite,
      visibleReasoning: usage.reasoning,
      visiblePricingUnknown: usage.pricingUnknown,
      visibleOutputReported: usage.outputReported,
    }),
  )
}

function subtotal(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/** Host-only wire sidecar. Public Usage values remain ordinary JSON objects. */
export function encodeUsageReceipt(usage: UsageCounts): UsageReceipt {
  const state = readAccounting(usage)
  return {
    aggregate: state.aggregate,
    ...(state.knownCost !== undefined ? { knownCost: state.knownCost } : {}),
    hasReportedCost: state.hasReportedCost,
    ...(state.knownSearchCost !== undefined ? { knownSearchCost: state.knownSearchCost } : {}),
    unpricedSearchRequests: state.unpricedSearchRequests,
    unpricedTokens: state.unpricedTokens,
    unknownContributions: state.unknownContributions,
    unpricedContributions: state.unpricedContributions,
    unreportedContributions: state.unreportedContributions,
  }
}

/** Strictly restore private accounting after decoding the corresponding visible Usage. */
export function decodeUsageReceipt(usage: UsageCounts, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage receipt")
  const record = value as Record<string, unknown>
  const booleans = ["aggregate", "hasReportedCost"]
  const optional = ["knownCost", "knownSearchCost"]
  const numbers = [
    "unpricedSearchRequests",
    "unpricedTokens",
    "unknownContributions",
    "unpricedContributions",
    "unreportedContributions",
  ]
  if (
    Object.keys(record).some((key) => ![...booleans, ...optional, ...numbers].includes(key)) ||
    booleans.some((key) => typeof record[key] !== "boolean") ||
    numbers.some((key) => typeof record[key] !== "number" || !Number.isFinite(record[key])) ||
    optional.some(
      (key) =>
        record[key] !== undefined && (typeof record[key] !== "number" || !Number.isFinite(record[key])),
    )
  )
    throw new Error("Invalid usage receipt")
  retain(usage, record as unknown as UsageReceipt)
}

/** Internal to addUsage: retain known subtotals independently of displayed prices. */
export function sumUsageAccounting(a: UsageCounts, b: UsageCounts, sum: UsageCounts): void {
  const left = readAccounting(a)
  const right = readAccounting(b)
  const state: UsageAccounting = Object.freeze({
    aggregate: true,
    knownCost: subtotal(left.knownCost, right.knownCost),
    hasReportedCost: left.hasReportedCost || right.hasReportedCost,
    knownSearchCost: subtotal(left.knownSearchCost, right.knownSearchCost),
    unpricedSearchRequests: left.unpricedSearchRequests + right.unpricedSearchRequests,
    unpricedTokens: left.unpricedTokens + right.unpricedTokens,
    unknownContributions: left.unknownContributions + right.unknownContributions,
    unpricedContributions: left.unpricedContributions + right.unpricedContributions,
    unreportedContributions: left.unreportedContributions + right.unreportedContributions,
  })
  if (state.unreportedContributions > 0) sum.outputReported = false
  else delete sum.outputReported
  if (state.unknownContributions > 0) sum.pricingUnknown = true
  else delete sum.pricingUnknown
  if (state.unpricedSearchRequests <= 0) {
    if (state.hasReportedCost && state.knownCost !== undefined) sum.cost = state.knownCost
    if (state.knownSearchCost !== undefined) sum.webSearchCost = state.knownSearchCost
  }
  retain(sum, state)
}

/** Unresolved token, search, or explicit pricing evidence, including hidden aggregate state. */
export function hasUnpricedUsage(usage: UsageCounts): boolean {
  const state = readAccounting(usage)
  return (
    state.unpricedTokens > 0 ||
    state.unpricedSearchRequests > 0 ||
    state.unknownContributions > 0 ||
    state.unpricedContributions > 0 ||
    state.unreportedContributions > 0
  )
}

/** Explicit aggregate provenance survives copies and coverage flags, but not edits to its amount fields. */
export function isUsageAggregate(usage: UsageCounts): boolean {
  return readAccounting(usage).aggregate
}

/** Known USD subtotal, even when an unresolved search makes the displayed total unknown. */
export function knownUsageCost(usage: UsageCounts): number | undefined {
  return readAccounting(usage).knownCost
}

/** Call after copying numeric fields into a mutable aggregate; Object.assign loses private state. */
export function transferUsageAccounting(from: UsageCounts, to: UsageCounts, sign: 1 | -1 = 1): void {
  const state = readAccounting(from)
  retain(
    to,
    sign === 1
      ? state
      : {
          aggregate: state.aggregate,
          knownCost: state.knownCost === undefined ? undefined : -state.knownCost,
          hasReportedCost: state.hasReportedCost,
          knownSearchCost: state.knownSearchCost === undefined ? undefined : -state.knownSearchCost,
          unpricedSearchRequests: -state.unpricedSearchRequests,
          unpricedTokens: -state.unpricedTokens,
          unknownContributions: -state.unknownContributions,
          unpricedContributions: -state.unpricedContributions,
          unreportedContributions: -state.unreportedContributions,
        },
  )
}
