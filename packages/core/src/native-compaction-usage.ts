import type { Ai, CompactReceipt, ModelRef, Usage } from "@amira/ai"
import { coveredStatements, usageCoverage } from "./accounting-coverage.ts"
import {
  copyAccountingUsage,
  markAccountingIncomplete,
  reportedUsage,
  retainAccountingReceipts,
  usageStatements,
} from "./accounting-receipts.ts"
import type { Agent } from "./agent.ts"
import { claimNativeReceipt, retainUsageReceipt } from "./owned-conversations-receipts.ts"
import { recordConversationUsage } from "./owned-conversations-usage.ts"
import type { SessionStore } from "./session-store.ts"
import type { UsageAttribution } from "./session-usage.ts"
import type { Child } from "./subagents/child.ts"
import { retainUsageStatement } from "./usage-statements.ts"

interface Destination {
  store?: SessionStore
  attribution?: UsageAttribution
  record: (usage: Usage, model: ModelRef) => void
}
const destinations = new WeakMap<Agent, Destination>()
const missingUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  outputReported: false,
  pricingUnknown: true,
})

/** Keep the accounting child after its lifecycle leaves the live tree, as consultations do. */
export function registerNativeAccounting(
  child: Child,
  record: (usage: Usage, model: ModelRef) => void,
): void {
  destinations.set(child.agent, {
    store: child.ephemeral ? child.usageStore : child.agent.session,
    ...(child.ephemeral
      ? {
          attribution: {
            sessionId: child.id,
            parentSessionId: child.parentSessionId,
            ...(child.groupId ? { groupId: child.groupId } : {}),
            ephemeral: true,
          },
        }
      : {}),
    record,
  })
}

/** Observe native receipts independently of the compactor's timeout/fallback result. */
export function withNativeCompactionUsage(ai: Ai, agent: Agent): Ai {
  return {
    ...ai,
    stream: (request, signal) => ai.stream(request, signal),
    nativeCompaction: (model) => ai.nativeCompaction(model),
    async compact(request, signal, onProgress, onUsage) {
      const record = lateNativeUsage(agent, { provider: request.model.provider, model: request.model.id })
      const physical: Usage[] = []
      const result = await ai.compact(request, signal, onProgress, (receipt) => {
        if (!receipt.late) {
          const usage = receipt.usage ? copyAccountingUsage(receipt.usage) : missingUsage()
          retainUsageStatement(usage, receipt.id, 1, "snapshot", usageCoverage(usage))
          physical.push(usage)
        }
        record(receipt)
        return onUsage?.(receipt)
      })
      const usage = result.usage ? copyAccountingUsage(result.usage) : missingUsage()
      for (const receipt of physical) retainAccountingReceipts(usage, receipt)
      if (!physical.length)
        retainUsageStatement(usage, crypto.randomUUID(), 1, "snapshot", usageCoverage(usage, undefined, true))
      const incomplete =
        result.usageIncomplete === true ||
        (!result.ok && (result.timedOut === true || result.aborted === true)) ||
        !coveredStatements(usageStatements(usage))
      if (incomplete) markAccountingIncomplete(usage)
      return { ...result, usage, ...(incomplete ? { usageIncomplete: true } : {}) }
    },
  }
}

/** Capture identity now; a late provider receipt must never follow the host's replacing main. */
export function lateNativeUsage(agent: Agent, model: ModelRef): (receipt: CompactReceipt) => void {
  const destination: Destination = destinations.get(agent) ?? {
    store: agent.session,
    record: (usage: Usage, model: ModelRef) => {
      if (agent.tree) agent.tree.recordUsage(agent, usage, model)
      else recordConversationUsage(agent, usage, model)
    },
  }
  return (receipt) => {
    // Timely usage is retained in the compaction aggregate. Only late receipts take this path.
    if (!receipt.late || !claimNativeReceipt(agent, destination.store, receipt.id)) return
    const usage = reportedUsage(receipt.usage ?? missingUsage(), receipt.id)
    // Identity and charge share one side_usage write, including when it follows a new writer.
    retainUsageReceipt(agent, destination.store, usage, destination.attribution)
    destination.record(usage, model)
  }
}
