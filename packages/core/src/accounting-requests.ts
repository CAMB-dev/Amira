import type { Ai, Usage } from "@amira/ai"
import { transferUsageAccounting } from "@amira/ai/accounting"
import type { Budget } from "@amira/api"
import { coveredStatements, requestCoverage } from "./accounting-coverage.ts"
import {
  type AccountingAttempt,
  accountingAttempt,
  bindUsageStatements,
  copyAccountingUsage,
  observeAccountingAttempt,
  recordAccountingReceipts,
  usageStatements,
} from "./accounting-receipts.ts"
import type { Agent } from "./agent.ts"
import { withCallableServerTools } from "./callable-server-tools.ts"
import { withNativeCompactionUsage } from "./native-compaction-usage.ts"
import type { SessionStore } from "./session-store.ts"
import type { UsageAttribution } from "./session-usage.ts"
import type { Child } from "./subagents/child.ts"

const namespace = "amira.accounting-requests"

export interface AccountingTarget {
  store?: SessionStore
  attribution?: UsageAttribution
}

const targets = new WeakMap<Agent, AccountingTarget>()
const usageOwners = new WeakMap<Agent, Agent>()
const cleanups = new Map<string, Set<Promise<void>>>()

/** Wait for the currently running outer wrappers, including their final receipt bookkeeping. */
export async function accountingCleanup(sessionId: string): Promise<void> {
  await Promise.all([...(cleanups.get(sessionId) ?? [])])
}

function trackCleanup(agent: Agent): () => void {
  const cleanup = Promise.withResolvers<void>()
  const active = cleanups.get(agent.sessionId) ?? new Set<Promise<void>>()
  cleanups.set(agent.sessionId, active)
  active.add(cleanup.promise)
  return () => {
    active.delete(cleanup.promise)
    if (!active.size) cleanups.delete(agent.sessionId)
    cleanup.resolve()
  }
}

/** Owned descendants inherit only the durable accounting destination, never private messages. */
export function registerChildAccounting(child: Child): void {
  if (child.usageOwner) usageOwners.set(child.agent, child.usageOwner)
  targets.set(child.agent, {
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
  })
}

export function requestAccountingTarget(agent: Agent): AccountingTarget {
  return targets.get(agent) ?? (agent.session?.header.owned ? { store: agent.session } : {})
}

interface RequestReceipt {
  store: SessionStore
  requestId: string
  ended: boolean
  verifiable: boolean
  attempts: AccountingAttempt[]
}
const pending = new WeakMap<Agent, Set<RequestReceipt>>()

function begin(agent: Agent, target: AccountingTarget): RequestReceipt | undefined {
  const { store, attribution } = target
  if (!store) return undefined
  const requestId = crypto.randomUUID()
  const attempt = accountingAttempt()
  // Fail before dispatch when even the accounting intent cannot be retained.
  store.append({
    type: "custom",
    ext: namespace,
    data: { v: 2, phase: "start", requestId, attemptId: attempt.id, attribution },
  })
  const receipt = { store, requestId, ended: false, verifiable: true, attempts: [attempt] }
  const requests = pending.get(agent) ?? new Set<RequestReceipt>()
  requests.add(receipt)
  pending.set(agent, requests)
  return receipt
}

function finish(agent: Agent): void {
  for (const receipt of pending.get(agent) ?? []) {
    if (
      !receipt.ended ||
      !receipt.verifiable ||
      receipt.attempts.some(
        (attempt) =>
          !attempt.reported ||
          !attempt.covered ||
          !attempt.receipts.size ||
          attempt.recorded < attempt.revision,
      )
    )
      continue
    if (!receipt.store.accountingDurable) continue
    try {
      receipt.store.append({
        type: "custom",
        ext: namespace,
        data: {
          v: 2,
          phase: "end",
          requestId: receipt.requestId,
          attemptCount: receipt.attempts.length,
          attempts: receipt.attempts.map((attempt) => ({ id: attempt.id, receipts: [...attempt.receipts] })),
        },
      })
      pending.get(agent)?.delete(receipt)
    } catch {
      // Keep the start unresolved after a failed receipt/end write, including across restart.
    }
  }
}

/** Called after retaining a charge and before budget.update is emitted. */
export function accountingRecorded(agent: Agent, usage: Usage): void {
  recordAccountingReceipts(usage)
  finish(agent)
}

/** A compactor retains the combined receipt after all of its physical requests have ended. */
export function accountingAuxiliaryRecorded(agent: Agent, usage?: Usage): void {
  if (usage) accountingRecorded(agent, usage)
  else finish(agent)
  emitUsageInvalidation(agent)
}

/** Agent requests retain accounting intent only for independently owned scopes. */
export function accountedAi(ai: Ai, agent: Agent, callable: ReadonlySet<string> | undefined): Ai {
  return withCallableServerTools(
    withAccountingRequests(withNativeCompactionUsage(ai, agent), agent, () => requestAccountingTarget(agent)),
    callable,
  )
}

/** Durable request fences shared by normal turns, compaction and text-only completions. */
export function withAccountingRequests(ai: Ai, agent: Agent, target: () => AccountingTarget): Ai {
  return {
    ...ai,
    nativeCompaction: (model) => ai.nativeCompaction(model),
    async *stream(request, signal) {
      const receipt = begin(agent, target())
      const cleaned = trackCleanup(agent)
      let attempt = receipt?.attempts[0]
      let backoff = false
      let dispatched = false
      let terminal = false
      const dispatches = new Set<string>()
      let lastUsage: Usage | undefined
      try {
        for await (let event of ai.stream(request, signal)) {
          if (event.type === "request.attempt") {
            if (dispatches.has(event.id)) continue
            dispatches.add(event.id)
            terminal = false
          }
          if (event.type === "done" || event.type === "error") terminal = true
          if (event.type === "retry" || event.type === "fast.fallback") {
            backoff = true
            terminal = false
          } else {
            // Opened retry/fallback attempts provide a boundary even when their first
            // provider event is aborted. Only an abort without that boundary is synthetic.
            const repeated = backoff && event.type === "error" && event.error.code === "aborted"
            if ((backoff && !repeated) || (event.type === "request.attempt" && dispatched)) {
              if (receipt) {
                attempt = accountingAttempt()
                receipt.attempts.push(attempt)
                try {
                  receipt.store.append({
                    type: "custom",
                    ext: namespace,
                    data: {
                      v: 2,
                      phase: "attempt",
                      requestId: receipt.requestId,
                      attemptId: attempt.id,
                    },
                  })
                } catch {
                  // Already-reported usage must still reach its booker even when this proof fails.
                  receipt.verifiable = false
                }
              }
              backoff = false
              dispatched = false
            }
            if (event.type === "request.attempt") dispatched = true
            if (
              attempt &&
              (event.type === "request.end" || event.type === "done" || event.type === "error")
            ) {
              const source = event.message.usage
              // Providers may reuse/mutate Usage, even across concurrent requests. Own each receipt.
              const usage = repeated ? lastUsage : source ? { ...source } : undefined
              if (source && usage) transferUsageAccounting(source, usage)
              if (!repeated) observeAccountingAttempt(attempt, usage)
              event = { ...event, message: { ...event.message, usage } }
              lastUsage = usage
            }
          }
          yield event
        }
      } catch (error) {
        // A broken iterator can hide a new attempt or a late receipt; never certify its tail.
        if (attempt) attempt.covered = false
        throw error
      } finally {
        try {
          if (receipt) {
            receipt.ended = true
            receipt.verifiable &&= terminal
          }
          finish(agent)
          if (receipt) emitUsageInvalidation(agent)
        } finally {
          cleaned()
        }
      }
    },
    async compact(request, signal, onProgress, onUsage) {
      const receipt = begin(agent, target())
      const cleaned = trackCleanup(agent)
      try {
        const result = await ai.compact(request, signal, onProgress, onUsage)
        if (!receipt) return result
        const usage = result.usage ? copyAccountingUsage(result.usage) : undefined
        const attempt = receipt.attempts[0]!
        observeAccountingAttempt(attempt, usage)
        if (usage) bindUsageStatements(usage)
        attempt.covered &&= !result.usageIncomplete && !!usage && coveredStatements(usageStatements(usage))
        return { ...result, ...(usage ? { usage } : {}) }
      } finally {
        try {
          if (receipt) receipt.ended = true
          finish(agent)
        } finally {
          cleaned()
        }
      }
    },
  }
}

/** Interrupted requests retain identity only, never private prompts or transcripts. */
export function unfinishedAccounting(store: SessionStore): { attribution?: UsageAttribution }[] {
  return requestCoverage(store.entries)
    .filter((requirement) => !requirement.verified)
    .map(({ attribution }) => ({ ...(attribution ? { attribution } : {}) }))
}

export function emitUsageInvalidation(
  agent: Agent,
  usage: Readonly<Usage> | undefined = agent.tree?.usage,
  limit: Budget | undefined = agent.tree?.budget,
): void {
  if (!usage) return
  agent = usageOwners.get(agent) ?? agent
  agent.bus.emit(
    "budget.update",
    {
      tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
      ...(usage.pricingUnknown ? { pricingUnknown: true } : {}),
      ...(limit ? { limit } : {}),
    },
    {
      sessionId: agent.sessionId,
      ...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
    },
  )
}
