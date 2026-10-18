import type { ModelRef, Usage } from "@amira/ai"
import type { ConversationUsageSnapshot } from "@amira/api"
import { type CoverageRequirement, requestCoverage } from "./accounting-coverage.ts"
import { entryAccounting, recordAccountingReceipts } from "./accounting-receipts.ts"
import type { Agent } from "./agent.ts"
import { accountingDescendants } from "./owned-conversations-descendants.ts"
import {
  hasDurableReceipt,
  identifiedUsage,
  type ReceiptEvidence,
  retainUsageReceipt,
  usageReceiptEvidence,
} from "./owned-conversations-receipts.ts"
import { SessionStore } from "./session-store.ts"
import { accountUsage, type UsageAttribution, type UsageReceipt } from "./session-usage.ts"
import type { AgentTree } from "./subagents.ts"

const volatileChildren = new WeakMap<
  AgentTree,
  Map<
    string,
    {
      attribution: UsageAttribution
      receipts: ReceiptEvidence[]
    }
  >
>()

/** Called by recordUsage before its budget.update invalidation notification. */
export function recordConversationUsage(
  agent: Agent,
  usage: Usage,
  model: ModelRef = { provider: agent.model.provider, model: agent.model.id },
  attribution?: UsageAttribution,
  store = agent.session,
): void {
  if (store?.takeUsageReceipt(usage)) return
  usage = identifiedUsage(usage)
  retainUsageReceipt(agent, store, usage, attribution)
  if (hasDurableReceipt(store, entryAccounting(usage).receiptId!)) return
  if (store) {
    try {
      store.append({
        type: "side_usage",
        model,
        usage,
        label: "accounting",
        ...(attribution ? { attribution } : {}),
      })
      store.takeUsageReceipt(usage)
      recordAccountingReceipts(usage)
      return
    } catch {
      // The tree still books paid work when its session cannot be saved. A live reader must
      // retain it, but cannot certify it as durable. SessionStore records the failure too.
    }
  }
  if (!store && agent.parentSessionId && agent.tree) {
    const { receipts: rows } = usageReceiptEvidence(undefined, agent)
    let children = volatileChildren.get(agent.tree)
    if (!children) {
      children = new Map()
      volatileChildren.set(agent.tree, children)
    }
    const identity = attribution ?? {
      sessionId: agent.sessionId,
      parentSessionId: agent.parentSessionId,
    }
    children.set(agent.sessionId, { attribution: identity, receipts: rows })
  }
}

/** A runtime-free reader for stores, or the same evidence plus unsaved receipts for live agents. */
export function conversationUsage(
  source: Agent | SessionStore,
  tree: AgentTree | undefined = source instanceof SessionStore ? undefined : source.tree,
  requirements: readonly CoverageRequirement[] = [],
): ConversationUsageSnapshot {
  const store = source instanceof SessionStore ? source : source.session
  const sessionId = source instanceof SessionStore ? source.id : source.sessionId
  const ownRows: UsageReceipt[] = []
  const descendants = new Map<
    string,
    {
      identity: UsageAttribution
      receipts: UsageReceipt[]
      requirements: CoverageRequirement[]
    }
  >()
  let revision = 0
  const addPrivate = (
    identity: UsageAttribution,
    receipt: UsageReceipt | undefined,
    requirements: readonly CoverageRequirement[],
  ) => {
    if (!/^[\w-]+$/.test(identity.sessionId) || identity.sessionId === sessionId)
      throw new Error("Invalid private accounting identity")
    let child = descendants.get(identity.sessionId)
    if (!child) {
      child = { identity, receipts: [], requirements: [] }
      descendants.set(identity.sessionId, child)
      revision++
    }
    if (child.identity.parentSessionId !== identity.parentSessionId)
      throw new Error("Conflicting private accounting parent")
    if (receipt) child.receipts.push(receipt)
    child.requirements.push(...requirements)
  }
  const read = (
    evidence: SessionStore | undefined,
    target: UsageReceipt[],
    live?: Agent,
    supplied?: ReturnType<typeof usageReceiptEvidence>,
  ) => {
    const requirements: CoverageRequirement[] = []
    const { receipts, intact, entries } = supplied ?? usageReceiptEvidence(evidence, live)
    for (const entry of entries) {
      if (entry.type === "custom" && entry.ext === "amira.accounting-requests") revision++
    }
    for (const receipt of receipts) {
      revision += receipt.revision
      if (receipt.attribution)
        addPrivate(receipt.attribution, receipt, [{ kind: "integrity", verified: intact }])
      else target.push(receipt)
    }
    for (const request of evidence ? requestCoverage(entries) : []) {
      if (request.attribution) addPrivate(request.attribution, undefined, [request])
      else requirements.push(request)
    }
    requirements.push({ kind: "integrity", verified: intact })
    return requirements
  }
  const live = source instanceof SessionStore ? undefined : source
  const evidence = usageReceiptEvidence(store, live)
  const ownRequirements = [...requirements, ...read(store, ownRows, live, evidence)]
  const traversal = accountingDescendants(sessionId, evidence.currentStore ?? store, tree)
  for (const entry of traversal.entries) {
    const identity: UsageAttribution = {
      sessionId: entry.info.id,
      parentSessionId: entry.info.parentSessionId,
      ...(entry.info.groupId ? { groupId: entry.info.groupId } : {}),
    }
    if (
      entry.session &&
      (entry.session.id !== identity.sessionId || entry.session.header.parent !== identity.parentSessionId)
    )
      throw new Error("Subagent accounting identity does not match its parent")
    const child = { identity, receipts: [] as UsageReceipt[], requirements: [] as CoverageRequirement[] }
    descendants.set(identity.sessionId, child)
    revision++
    child.requirements = read(
      entry.session,
      child.receipts,
      undefined,
      usageReceiptEvidence(entry.session, undefined, entry.accountingDestination),
    )
  }
  // Children without session files keep only accounting, never their private transcript.
  const reachable = new Set([sessionId, ...descendants.keys()])
  const remaining = new Map(volatileChildren.get(tree!) ?? [])
  while (remaining.size) {
    let found = false
    for (const [id, child] of remaining) {
      if (!reachable.has(child.attribution.parentSessionId)) continue
      const existing = descendants.get(id)
      if (existing) {
        existing.receipts.push(...child.receipts)
        existing.requirements.push({ kind: "integrity", verified: false })
      } else {
        revision++
        descendants.set(id, {
          identity: child.attribution,
          receipts: child.receipts,
          requirements: [{ kind: "integrity", verified: false }],
        })
      }
      revision += child.receipts.length
      reachable.add(id)
      remaining.delete(id)
      found = true
    }
    if (!found) break
  }
  for (const child of descendants.values()) {
    const seen = new Set([child.identity.sessionId])
    let parent = child.identity.parentSessionId
    while (parent !== sessionId) {
      if (seen.has(parent) || !descendants.has(parent))
        throw new Error("Private accounting identity is outside this conversation")
      seen.add(parent)
      parent = descendants.get(parent)!.identity.parentSessionId
    }
  }
  const own = accountUsage(ownRows, ownRequirements)
  const rows = [...descendants.values()].map((child) => ({
    ...child.identity,
    usage: accountUsage(child.receipts, child.requirements),
  }))
  const total = accountUsage(
    [...ownRows, ...[...descendants.values()].flatMap((child) => child.receipts)],
    [
      ...ownRequirements,
      ...traversal.requirements,
      ...[...descendants.values()].flatMap((child) => child.requirements),
    ],
  )
  return freeze({ sessionId, revision, own, total, descendants: rows })
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  return value
}
