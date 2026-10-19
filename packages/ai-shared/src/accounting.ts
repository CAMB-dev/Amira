// Internal accounting seam for mutable aggregates and minimum-cost budget checks.
// Deliberately not part of the root runtime exports or the public API package.
export {
  decodeUsageReceipt,
  encodeUsageReceipt,
  hasUnpricedUsage,
  isUsageAggregate,
  knownUsageCost,
  transferUsageAccounting,
  type UsageReceipt,
} from "./usage-accounting.ts"
