import { emptyUsage, addUsage as sumUsage, type Usage } from "@amira/ai"
import type { Budget } from "@amira/api"

/** All tokens a reply used, cache included: what a token budget counts. */
export function usageTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

export function addUsage(to: Usage, u: Usage) {
  const sum = sumUsage(to, u)
  if (sum.cost === undefined) delete to.cost
  if (sum.webSearchCost === undefined) delete to.webSearchCost
  Object.assign(to, sum)
}

/** Why `used` is over `limit`, if it is. */
export function overBudget(used: Usage, limit: Budget | undefined): string | undefined {
  if (!limit) return undefined
  const tokens = usageTokens(used)
  if (limit.tokens !== undefined && tokens > limit.tokens)
    return `${tokens} tokens used, limit ${limit.tokens}`
  if (limit.costUsd !== undefined && used.cost !== undefined && used.cost > limit.costUsd) {
    return `$${used.cost.toFixed(4)} spent, limit $${limit.costUsd}`
  }
  return undefined
}

/** Shared cost/token accounting and limit arithmetic for an agent tree. */
export class BudgetLedger {
  readonly usage = emptyUsage()
  #exceeded: string | undefined

  constructor(readonly limit: Budget | undefined) {}

  get exceeded(): string | undefined {
    return this.#exceeded
  }

  add(usage: Usage): void {
    addUsage(this.usage, usage)
  }

  /** Carves a group's requested budget down to what remains in the tree. */
  carve(asked: Budget | undefined): Budget | undefined {
    if (!asked) return undefined
    const out: Budget = {}
    if (asked.tokens !== undefined) {
      const left = this.limit?.tokens !== undefined ? this.limit.tokens - usageTokens(this.usage) : Infinity
      out.tokens = Math.max(0, Math.min(asked.tokens, left))
    }
    if (asked.costUsd !== undefined) {
      const left = this.limit?.costUsd !== undefined ? this.limit.costUsd - (this.usage.cost ?? 0) : Infinity
      out.costUsd = Math.max(0, Math.min(asked.costUsd, left))
    }
    return out
  }

  markExceeded(reason: string): void {
    this.#exceeded = reason
  }
}
