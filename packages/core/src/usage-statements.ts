import type { Usage } from "@amira/ai"
import { knownUsageCost } from "@amira/ai/accounting"
import { type UsageCoverage, usageCoverage } from "./accounting-coverage.ts"

/** Full revisions identify one logical contribution independently of its signed journal rows. */
export interface AccountingStatement {
  v: 1
  id: string
  revision: number
  kind: "snapshot" | "credit"
  usage: Usage
  knownCostUsd: number
  coverage: UsageCoverage
  attempts?: { id: string; revision: number }[]
}

const statements = new WeakMap<Usage, AccountingStatement>()

export function statementOf(usage: Usage): AccountingStatement | undefined {
  return statements.get(usage)
}

/** Metadata lives beside the usage, never on a provider-owned object or its public shape. */
export function retainUsageStatement(
  usage: Usage,
  id: string,
  revision: number,
  kind: AccountingStatement["kind"],
  coverage = usageCoverage(usage),
): void {
  statements.set(usage, {
    v: 1,
    id,
    revision,
    kind,
    usage: { ...usage },
    knownCostUsd: knownUsageCost(usage) ?? 0,
    coverage,
  })
}
