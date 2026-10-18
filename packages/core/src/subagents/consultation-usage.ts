import type { Usage } from "@amira/ai"
import { hasUnpricedUsage, knownUsageCost, transferUsageAccounting } from "@amira/ai/accounting"
import { usageCoverage } from "../accounting-coverage.ts"
import {
  accountingIncomplete,
  retainAccountingReceipts,
  retainReportedUsage,
  usageSnapshot,
} from "../accounting-receipts.ts"
import { retainUsageStatement } from "../usage-statements.ts"

/** One attempt is observed eagerly and settled once with its latest terminal usage. */
export type ConsultationUsageRecorder = ((usage: Usage) => void) & {
  observe?: (usage: Usage) => Usage
}

/** Captured for a consultation; its statement resets whenever an attempt is settled. */
export function consultationUsageRecorder(book: (usage: Usage) => void): ConsultationUsageRecorder {
  let charged: Usage | undefined
  let id = crypto.randomUUID()
  let revision = 0
  const observe = (usage: Usage): Usage => {
    // Provider messages and their usage objects can be reused or changed after an event.
    const previous = charged
    const snapshot = usageSnapshot(usage, previous)
    if (previous && sameAccounting(snapshot, previous)) {
      // Rebind only to this retained contribution. Its durable identity/commit proof, if any,
      // permits acknowledging a newer physical receipt without manufacturing a charge.
      retainAccountingReceipts(previous, usage)
      return previous
    }
    if (previous) {
      const credit = inverse(previous)
      retainUsageStatement(credit, id, revision, "credit", coverageOf(previous))
      book(credit)
    }
    revision++
    retainUsageStatement(snapshot, id, revision, "snapshot", coverageOf(snapshot))
    charged = snapshot
    book(snapshot)
    return snapshot
  }
  return Object.assign(
    (usage: Usage) => {
      try {
        return observe(usage)
      } finally {
        charged = undefined
        id = crypto.randomUUID()
        revision = 0
      }
    },
    { observe },
  )
}

function coverageOf(usage: Usage) {
  return usageCoverage(usage, knownUsageCost(usage) ?? 0, accountingIncomplete(usage))
}

function sameAccounting(left: Usage, right: Usage): boolean {
  return (
    Object.keys({ ...left, ...right }).every(
      (key) => left[key as keyof Usage] === right[key as keyof Usage],
    ) &&
    knownUsageCost(left) === knownUsageCost(right) &&
    hasUnpricedUsage(left) === hasUnpricedUsage(right) &&
    accountingIncomplete(left) === accountingIncomplete(right)
  )
}

function inverse(usage: Usage): Usage {
  const credit: Usage = {
    input: -usage.input,
    output: -usage.output,
    cacheRead: -usage.cacheRead,
    cacheWrite: -usage.cacheWrite,
  }
  for (const key of ["reasoning", "webSearchRequests", "webSearchCost", "cost"] as const) {
    if (usage[key] !== undefined) credit[key] = -usage[key]
  }
  if (usage.outputReported !== undefined) credit.outputReported = usage.outputReported
  if (usage.pricingUnknown) credit.pricingUnknown = true
  transferUsageAccounting(usage, credit, -1)
  retainAccountingReceipts(credit, usage)
  retainReportedUsage(credit, usage)
  return credit
}
