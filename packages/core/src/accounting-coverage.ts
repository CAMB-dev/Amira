import { createHash } from "node:crypto"
import type { Usage } from "@amira/ai"
import { hasUnpricedUsage, knownUsageCost } from "@amira/ai/accounting"
import { receiptSeal } from "./accounting-journal.ts"
import type { SessionEntry } from "./session-store.ts"
import type { UsageAttribution } from "./session-usage.ts"
import type { AccountingStatement } from "./usage-statements.ts"

/** Positive, serializable coverage evidence. Absence is unknown, never full coverage. */
export interface UsageCoverage {
  v: 1
  reported: boolean
  priced: boolean
  fingerprint: string
}
export interface CoverageRequirement {
  kind: "integrity" | "request" | "reference" | "reconciliation"
  verified: boolean
  attribution?: UsageAttribution
  receipts?: readonly string[]
}
export interface CoveredReceipt {
  usage: Usage
  knownCostUsd?: number
  coverage?: unknown
  durable?: boolean
  coverageIncomplete?: boolean
  receiptId?: string
  source?: "request" | "reported" | "unknown"
  statements?: unknown
  attempts?: unknown
  seal?: string
}
const counters = ["input", "output", "cacheRead", "cacheWrite"] as const
const namespace = "amira.accounting-requests"
const resolvedReceipts = new WeakSet<CoveredReceipt>()
const verifiedRequests = new WeakSet<CoverageRequirement>()
const validSeal = (receipt: CoveredReceipt) =>
  typeof receipt.seal === "string" && receipt.seal === receiptSeal(receipt)
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

function usageShape(value: unknown): value is Usage {
  return (
    object(value) &&
    counters.every((key) => finite(value[key])) &&
    ["cost", "reasoning", "webSearchRequests", "webSearchCost"].every(
      (key) => value[key] === undefined || finite(value[key]),
    ) &&
    ["outputReported", "pricingUnknown"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.speed === undefined || value.speed === "fast" || value.speed === "standard") &&
    (value.serviceTier === undefined || typeof value.serviceTier === "string")
  )
}
function coverageShape(value: unknown): value is UsageCoverage {
  return (
    object(value) &&
    value.v === 1 &&
    typeof value.reported === "boolean" &&
    typeof value.priced === "boolean" &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.fingerprint)
  )
}
function fingerprint(usage: Usage | undefined, known: number, reported: boolean, priced: boolean): string {
  const fields = [
    ...counters,
    "cost",
    "reasoning",
    "webSearchRequests",
    "webSearchCost",
    "outputReported",
    "pricingUnknown",
    "speed",
    "serviceTier",
  ] as const
  const values = fields.map((key) => usage?.[key] ?? null)
  return createHash("sha256")
    .update(JSON.stringify([values, known, reported, priced]))
    .digest("hex")
}
export function usageCoverage(
  usage: Usage | undefined,
  known = usage ? (knownUsageCost(usage) ?? 0) : 0,
  blocked = false,
): UsageCoverage {
  const reported = !blocked && usageShape(usage) && usage.outputReported !== false
  const zero = reported && counters.every((key) => usage![key] === 0) && (usage!.webSearchRequests ?? 0) === 0
  const priced =
    reported &&
    !usage!.pricingUnknown &&
    !hasUnpricedUsage(usage!) &&
    (finite(usage!.cost) || (zero && known === 0))
  return { v: 1, reported, priced, fingerprint: fingerprint(usage, known, reported, priced) }
}
export function verifiedUsageCoverage(coverage: unknown, usage: Usage, known = usage.cost ?? 0): boolean {
  if (!coverageShape(coverage)) return false
  const actual = usageCoverage(usage, known)
  return (
    coverage.reported &&
    coverage.priced &&
    actual.reported &&
    actual.priced &&
    coverage.fingerprint === actual.fingerprint
  )
}
function coverageMatches(coverage: UsageCoverage, usage: Usage, known: number): boolean {
  return coverage.fingerprint === fingerprint(usage, known, coverage.reported, coverage.priced)
}
function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left), Math.abs(right))
}
function bindingsShape(value: unknown): value is { id: string; revision: number }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (binding) =>
        object(binding) &&
        id(binding.id) &&
        Number.isSafeInteger(binding.revision) &&
        (binding.revision as number) > 0,
    )
  )
}
function sameUsage(left: Usage, right: Usage, sign = 1): boolean {
  return (
    counters.every((key) => left[key] === right[key] * sign) &&
    ["cost", "reasoning", "webSearchRequests", "webSearchCost"].every((key) => {
      const a = left[key as keyof Usage],
        b = right[key as keyof Usage]
      return (
        (a === undefined && b === undefined) ||
        (typeof a === "number" && typeof b === "number" && a === b * sign)
      )
    })
  )
}
function statementShape(value: unknown): value is AccountingStatement {
  return (
    object(value) &&
    value.v === 1 &&
    id(value.id) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    (value.kind === "snapshot" || value.kind === "credit") &&
    usageShape(value.usage) &&
    finite(value.knownCostUsd) &&
    coverageShape(value.coverage) &&
    (value.attempts === undefined || bindingsShape(value.attempts)) &&
    (value.kind === "credit" || coverageMatches(value.coverage, value.usage, value.knownCostUsd))
  )
}

export function coveredStatements(statements: readonly AccountingStatement[]): boolean {
  return (
    statements.length > 0 &&
    statements.every(
      (statement) =>
        statementShape(statement) &&
        statement.kind === "snapshot" &&
        verifiedUsageCoverage(statement.coverage, statement.usage, statement.knownCostUsd),
    )
  )
}

/** Resolve full statement revisions, rather than inferring coverage from a sum of signed deltas. */
export function resolveAccounting(records: readonly CoveredReceipt[]): {
  receipts: CoveredReceipt[]
  requirements: CoverageRequirement[]
} {
  const receipts: CoveredReceipt[] = []
  const requirements: CoverageRequirement[] = []
  const groups = new Map<
    string,
    {
      snapshots: Map<number, AccountingStatement>
      credits: Map<number, AccountingStatement>
      durable: boolean
      valid: boolean
    }
  >()
  let structural = true
  for (const record of records) {
    structural &&= id(record.receiptId) && validSeal(record)
    const statements = record.statements
    if (statements === undefined) {
      receipts.push(record)
      continue
    }
    if (
      !Array.isArray(statements) ||
      !statements.length ||
      !coverageShape(record.coverage) ||
      !usageShape(record.usage) ||
      !finite(record.knownCostUsd)
    ) {
      structural = false
    }
    if (record.coverageIncomplete) requirements.push({ kind: "reconciliation", verified: false })
    if (!Array.isArray(statements) || !statements.length) {
      receipts.push(record)
      continue
    }
    if (!statements.every(statementShape)) {
      structural = false
      continue
    }
    const amount = statements.reduce((sum, statement) => sum + statement.knownCostUsd, 0)
    const metrics = [...counters, "reasoning", "webSearchRequests", "webSearchCost"] as const
    structural &&=
      finite(record.knownCostUsd) &&
      close(amount, record.knownCostUsd) &&
      metrics.every(
        (key) =>
          record.usage[key] === undefined ||
          close(
            record.usage[key] as number,
            statements.reduce((sum, statement) => sum + (statement.usage[key] ?? 0), 0),
          ),
      ) &&
      coverageShape(record.coverage) &&
      coverageMatches(record.coverage, record.usage, record.knownCostUsd!)
    if (record.source === "request")
      structural &&=
        bindingsShape(record.attempts) &&
        record.attempts.length > 0 &&
        record.attempts.every((binding) =>
          statements.some((statement) => statement.attempts?.some((entry) => entry.id === binding.id)),
        )
    else
      structural &&=
        record.source === "reported" && statements.every((statement) => !statement.attempts?.length)
    for (const statement of statements) {
      let group = groups.get(statement.id)
      if (!group) {
        group = { snapshots: new Map(), credits: new Map(), durable: true, valid: true }
        groups.set(statement.id, group)
      }
      group.durable &&= record.durable === true
      group.valid &&=
        (record.source === "request" || record.source === "reported") && finite(record.knownCostUsd)
      const target = statement.kind === "snapshot" ? group.snapshots : group.credits
      const previous = target.get(statement.revision)
      if (
        previous &&
        (!sameUsage(previous.usage, statement.usage) ||
          previous.knownCostUsd !== statement.knownCostUsd ||
          previous.coverage.reported !== statement.coverage.reported ||
          previous.coverage.priced !== statement.coverage.priced)
      )
        group.valid = false
      target.set(statement.revision, statement)
    }
  }
  if (!structural)
    return {
      receipts: [...records],
      requirements: [...requirements, { kind: "reconciliation", verified: false }],
    }
  for (const group of groups.values()) {
    const latest = [...group.snapshots.keys()].reduce((maximum, revision) => Math.max(maximum, revision), 0)
    group.valid &&= latest > 0 && latest === group.snapshots.size
    for (const [revision, snapshot] of group.snapshots) {
      if (revision < latest) {
        const credit = group.credits.get(revision)
        if (
          !credit ||
          !sameUsage(credit.usage, snapshot.usage, -1) ||
          credit.knownCostUsd !== -snapshot.knownCostUsd ||
          credit.coverage.reported !== snapshot.coverage.reported ||
          credit.coverage.priced !== snapshot.coverage.priced ||
          credit.coverage.fingerprint !== snapshot.coverage.fingerprint
        )
          group.valid = false
      }
    }
    if (group.credits.has(latest) || [...group.credits.keys()].some((revision) => revision > latest))
      group.valid = false
    const snapshot = group.snapshots.get(latest)
    requirements.push({ kind: "reconciliation", verified: group.valid && group.durable && !!snapshot })
    if (snapshot) {
      const receipt: CoveredReceipt = {
        usage: snapshot.usage,
        knownCostUsd: snapshot.knownCostUsd,
        coverage: snapshot.coverage,
        durable: group.durable,
        source: "reported",
      }
      resolvedReceipts.add(receipt)
      receipts.push(receipt)
    }
  }
  return { receipts, requirements }
}

export function representableAccounting(receipts: readonly CoveredReceipt[]): boolean {
  const fields = [...counters, "reasoning", "cost", "webSearchRequests", "webSearchCost"] as const
  return (
    fields.every((key) => finite(receipts.reduce((sum, receipt) => sum + (receipt.usage[key] ?? 0), 0))) &&
    finite(
      receipts.reduce(
        (sum, receipt) => sum + (receipt.knownCostUsd ?? knownUsageCost(receipt.usage) ?? 0),
        0,
      ),
    )
  )
}

/** The sole completeness decision. Callers supply facts, never a precomputed complete flag. */
export function completeAccounting(
  receipts: readonly CoveredReceipt[],
  requirements: readonly CoverageRequirement[],
  records = receipts,
): boolean {
  if (!receipts.every((receipt) => usageShape(receipt.usage)) || !representableAccounting(receipts))
    return false
  const retained = new Set(
    requirements
      .filter((requirement) => verifiedRequests.has(requirement) && requirement.verified)
      .flatMap((requirement) => [...(requirement.receipts ?? [])]),
  )
  const requestsRetained = records.every(
    (record) => record.source !== "request" || (!!record.receiptId && retained.has(record.receiptId)),
  )
  return (
    requestsRetained &&
    requirements.some((requirement) => requirement.kind === "integrity" && requirement.verified === true) &&
    requirements.every(
      (requirement) =>
        ["integrity", "request", "reference", "reconciliation"].includes(requirement.kind) &&
        requirement.verified === true,
    ) &&
    receipts.every(
      (receipt) =>
        receipt.durable === true &&
        receipt.coverageIncomplete !== true &&
        (resolvedReceipts.has(receipt) || (id(receipt.receiptId) && validSeal(receipt))) &&
        ((receipt.source === "request" && bindingsShape(receipt.attempts) && receipt.attempts.length > 0) ||
          (receipt.source === "reported" &&
            (receipt.attempts === undefined ||
              (bindingsShape(receipt.attempts) && receipt.attempts.length === 0)))) &&
        finite(receipt.knownCostUsd) &&
        (!finite(receipt.usage.cost) || close(receipt.knownCostUsd, receipt.usage.cost)) &&
        verifiedUsageCoverage(receipt.coverage, receipt.usage, receipt.knownCostUsd),
    )
  )
}

function attribution(value: unknown): UsageAttribution | undefined {
  if (value === undefined) return undefined
  if (
    !object(value) ||
    !id(value.sessionId) ||
    !id(value.parentSessionId) ||
    (value.groupId !== undefined && !id(value.groupId)) ||
    (value.ephemeral !== undefined && typeof value.ephemeral !== "boolean")
  )
    return undefined
  return value as unknown as UsageAttribution
}

/** Verify request manifests against actual receipt rows; deleting an end or receipt cannot prove zero spend. */
export function requestCoverage(entries: readonly SessionEntry[]): CoverageRequirement[] {
  const requirements: CoverageRequirement[] = []
  const starts = new Map<string, { data: Record<string, unknown>; index: number; attempts: Set<string> }>()
  const ends = new Set<string>()
  const claimed = new Set<string>()
  const owners = new Map<string, string>()
  const rows = new Map(
    entries
      .filter((entry) => entry.accounting?.receiptId)
      .map((entry) => [entry.accounting!.receiptId!, entry]),
  )
  const require = (verified: boolean, value?: unknown, receipts?: string[]) => {
    const proof: CoverageRequirement = {
      kind: "request",
      verified,
      ...(attribution(value) ? { attribution: attribution(value) } : {}),
      ...(receipts ? { receipts } : {}),
    }
    if (verified) verifiedRequests.add(proof)
    requirements.push(proof)
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "custom" || entry.ext !== namespace) continue
    const data = entry.data
    if (!object(data) || data.v !== 2 || !id(data.requestId)) {
      require(false, object(data) ? data.attribution : undefined)
      continue
    }
    if (data.phase === "start") {
      if (
        starts.has(data.requestId) ||
        !id(data.attemptId) ||
        (data.attribution !== undefined && !attribution(data.attribution))
      ) {
        require(false)
        continue
      }
      starts.set(data.requestId, { data, index, attempts: new Set([data.attemptId]) })
      owners.set(data.attemptId, data.requestId)
    } else if (data.phase === "attempt") {
      const start = starts.get(data.requestId)
      if (!start || !id(data.attemptId) || start.attempts.has(data.attemptId) || ends.has(data.requestId))
        require(false, start?.data.attribution)
      else {
        start.attempts.add(data.attemptId)
        owners.set(data.attemptId, data.requestId)
      }
    } else if (data.phase === "end") {
      const start = starts.get(data.requestId)
      if (
        !start ||
        ends.has(data.requestId) ||
        index <= start.index ||
        !Array.isArray(data.attempts) ||
        data.attemptCount !== data.attempts.length
      ) {
        require(false, start?.data.attribution)
        continue
      }
      ends.add(data.requestId)
      const expected = new Set<string>()
      const retained: string[] = []
      let verified = data.attempts.length === start.attempts.size
      for (const attempt of data.attempts) {
        if (
          !object(attempt) ||
          !id(attempt.id) ||
          expected.has(attempt.id) ||
          !start.attempts.has(attempt.id) ||
          !Array.isArray(attempt.receipts) ||
          !attempt.receipts.length
        ) {
          verified = false
          continue
        }
        expected.add(attempt.id)
        for (const receiptId of attempt.receipts) {
          const row = typeof receiptId === "string" ? rows.get(receiptId) : undefined
          const bound = row?.accounting?.attempts
          if (
            row?.accounting?.source !== "request" ||
            !Array.isArray(bound) ||
            !bound.some(
              (binding) =>
                object(binding) && binding.id === attempt.id && Number.isSafeInteger(binding.revision),
            )
          )
            verified = false
          else {
            const actual = row.type === "side_usage" ? row.attribution : undefined
            if (JSON.stringify(actual) !== JSON.stringify(start.data.attribution)) verified = false
            claimed.add(`${attempt.id}:${receiptId}`)
            retained.push(receiptId as string)
          }
        }
      }
      require(verified, start.data.attribution, retained)
    } else require(false)
  }
  for (const [key, start] of starts) if (!ends.has(key)) require(false, start.data.attribution)
  for (const entry of entries) {
    if (entry.accounting?.source !== "request") continue
    const bindings = entry.accounting.attempts
    require(Array.isArray(bindings) &&
      bindings.length > 0 &&
      bindings.every(
        (binding) =>
          object(binding) &&
          id(binding.id) &&
          Number.isSafeInteger(binding.revision) &&
          binding.revision > 0 &&
          (claimed.has(`${binding.id}:${entry.accounting!.receiptId}`) ||
            (owners.has(binding.id) && !ends.has(owners.get(binding.id)!))),
      ), entry.type === "side_usage" ? entry.attribution : undefined)
  }
  return requirements.length ? requirements : [{ kind: "request", verified: true }]
}
