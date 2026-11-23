import "./host-hooks.ts"
import type { ModelRef, Usage } from "@amira/ai"
import type { ConversationUsageSnapshot } from "@amira/api"
import type { Agent, SessionStore } from "@amira/core"
import {
  type AgentTreeHost,
  accountUsage,
  cloneUsage,
  entryUsage,
  type UsageAttribution,
} from "@amira/core/internal"
import { subagentsOf } from "./subagent-list.ts"
import type { AgentTree } from "./subagents.ts"

interface LiveUsageBucket {
  own: Usage[]
  descendants: { attribution: UsageAttribution; usage: Usage }[]
  revision: number
}

const liveUsage = new WeakMap<Agent, LiveUsageBucket>()

function bucketOf(agent: Agent): LiveUsageBucket {
  let bucket = liveUsage.get(agent)
  if (!bucket) {
    bucket = { own: [], descendants: [], revision: 0 }
    liveUsage.set(agent, bucket)
  }
  return bucket
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Records a usage charge for an owned or standalone conversation. If the session store already
 * persisted this exact usage object (via message/compaction/side_usage), no duplicate write occurs.
 */
export function recordConversationUsage(
  agent: Agent,
  usage: Usage,
  model: ModelRef = { provider: agent.model.provider, model: agent.model.id },
  attribution?: UsageAttribution,
  targetStore?: SessionStore,
): void {
  const store = targetStore ?? agent.session
  if (store?.takeUsageReceipt(usage)) return
  const copy = cloneUsage(usage)
  if (store) {
    try {
      store.append({
        type: "side_usage",
        model,
        usage: copy,
        label: "accounting",
        ...(attribution ? { attribution } : {}),
      })
      return
    } catch {
      // Fall back to in-memory live bucket so spend is never lost if disk fails.
    }
  }
  const bucket = bucketOf(agent)
  if (attribution) bucket.descendants.push({ attribution, usage: copy })
  else bucket.own.push(copy)
  bucket.revision++
}

/** Builds a frozen own + descendants + total usage snapshot for an owned conversation. */
export function conversationUsage(
  source: Agent | SessionStore,
  tree?: AgentTreeHost,
  durableOverride = true,
): ConversationUsageSnapshot {
  const isAgent = "sessionId" in source
  const store = isAgent ? source.session : source
  const sessionId = isAgent ? source.sessionId : source.id
  const activeTree = (tree ?? (isAgent ? source.tree : undefined)) as AgentTree | undefined
  const bucket = isAgent ? liveUsage.get(source) : undefined

  const ownRecords: Usage[] = []
  const attributed = new Map<string, { attribution: UsageAttribution; records: Usage[]; durable: boolean }>()

  const pushAttributed = (attr: UsageAttribution, usage: Usage, durable: boolean) => {
    let entry = attributed.get(attr.sessionId)
    if (!entry) {
      entry = { attribution: attr, records: [], durable }
      attributed.set(attr.sessionId, entry)
    }
    entry.records.push(usage)
    entry.durable &&= durable
  }

  if (store) {
    for (const entry of store.entries) {
      const usage = entryUsage(entry)
      if (!usage) continue
      if (entry.type === "side_usage" && entry.attribution) {
        pushAttributed(entry.attribution, usage, store.accountingDurable && durableOverride)
      } else {
        ownRecords.push(usage)
      }
    }
  }
  if (bucket) {
    for (const usage of bucket.own) ownRecords.push(usage)
    for (const item of bucket.descendants) pushAttributed(item.attribution, item.usage, false)
  }

  const ownDurable = durableOverride && (store?.accountingDurable ?? true) && (bucket?.own.length ?? 0) === 0
  const own = accountUsage(ownRecords, ownDurable)

  const descendants: ConversationUsageSnapshot["descendants"][number][] = []
  const seen = new Set<string>()
  const allRecords: Usage[] = [...ownRecords]
  let allDurable = ownDurable

  for (const child of subagentsOf(sessionId, store, activeTree, true)) {
    seen.add(child.info.id)
    const childRecords: Usage[] = []
    let childDurable = durableOverride
    if (child.session) {
      childDurable &&= child.session.accountingDurable
      for (const entry of child.session.entries) {
        const u = entryUsage(entry)
        if (u) childRecords.push(u)
      }
    } else if (child.info.usage) {
      childRecords.push(child.info.usage)
      if (!activeTree?.subagent(child.info.id)) childDurable = false
    } else {
      childDurable = false
    }
    const extra = attributed.get(child.info.id)
    if (extra) {
      childRecords.push(...extra.records)
      childDurable &&= extra.durable
    }
    allRecords.push(...childRecords)
    allDurable &&= childDurable
    descendants.push({
      sessionId: child.info.id,
      parentSessionId: child.info.parentSessionId,
      ...(child.info.groupId ? { groupId: child.info.groupId } : {}),
      usage: accountUsage(childRecords, childDurable),
    })
  }

  for (const [id, entry] of attributed) {
    if (seen.has(id)) continue
    allRecords.push(...entry.records)
    allDurable &&= entry.durable
    descendants.push({
      sessionId: id,
      parentSessionId: entry.attribution.parentSessionId,
      ...(entry.attribution.groupId ? { groupId: entry.attribution.groupId } : {}),
      ...(entry.attribution.ephemeral ? { ephemeral: true } : {}),
      usage: accountUsage(entry.records, entry.durable),
    })
  }

  const total = accountUsage(allRecords, allDurable)
  const revision = (store?.entries.length ?? 0) + (bucket?.revision ?? 0) + descendants.length
  return freeze({ sessionId, revision, own, total, descendants })
}
