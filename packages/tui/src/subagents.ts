import {
  type AnyEvent,
  agentStatusState,
  type EventEnvelope,
  fallbackTitle,
  type SpawnGroupInfo,
} from "@amira/api"
import type { Theme } from "@amira/tui-kit"
import {
  type AgentCounts,
  agentCounts,
  agentCountsMark,
  type SubagentLine,
  spawnGroupCounts,
  spawnGroupRow,
  subagentEndLine,
  subagentRows,
  treeLayout,
} from "./format.ts"
import { serverToolCall } from "./server-tools.ts"
import { callSummary, type PresenterSource } from "./tool-view.ts"

/** A sub-agent the UI follows: its row, where it hangs, and how it ended once it did. */
export interface SubagentNode extends SubagentLine {
  id: string
  /** The session that started it: the main one, or another sub-agent's. */
  parent: string
  /** The call of `parent` that started it. */
  toolCallId?: string
  /** The spawn group it counts against. */
  groupId?: string
  end?: {
    status: "done" | "error" | "aborted"
    error?: string
    /** Why it ended early without failing: stopped, turn limit. */
    note?: string
    durationMs: number
    tokens: number
  }
}

/** The node a subagent.start event describes, not placed anywhere yet. */
export function startedNode(e: EventEnvelope<"subagent.start">, groups?: SpawnGroups): SubagentNode {
  const node: SubagentNode = {
    id: e.data.childSessionId,
    parent: e.sessionId,
    ...(e.data.toolCallId ? { toolCallId: e.data.toolCallId } : {}),
    ...(e.data.groupId ? { groupId: e.data.groupId } : {}),
    title: e.data.title || fallbackTitle(e.data.prompt),
    role: e.data.role ?? "agent",
    depth: e.data.depth,
    tokens: 0,
    ...(e.data.queued ? {} : { startedAt: e.ts }),
  }
  if (groups) trackGroupNode(groups, node)
  return node
}

/** Records a subagent.end event on its node and retains its outcome before the row is pruned. */
export function endNode(node: SubagentNode, e: EventEnvelope<"subagent.end">, groups?: SpawnGroups): void {
  node.end = {
    status: e.data.status,
    ...(e.data.error !== undefined ? { error: e.data.error } : {}),
    ...(e.data.note !== undefined ? { note: e.data.note } : {}),
    durationMs: e.data.durationMs,
    tokens: node.tokens,
  }
  if (groups) trackGroupNode(groups, node)
}

/**
 * Records a subagent.state event (a persistent sub-agent going idle between turns, or working
 * again). It comes with the parent's session id, so it is looked up by the child's.
 */
export function stateNode(node: SubagentNode, e: EventEnvelope<"subagent.state">): void {
  node.idle = e.data.state === "idle"
  node.paused = e.data.state === "paused"
  node.queued = e.data.state === "queued"
  // Its last tool belonged to the turn that ended.
  if (node.idle) delete node.activity
  if (e.data.state === "working") node.startedAt ??= e.ts
}

/** A current turn (including a user pause) or queued turn, not ended or idle between turns. */
export function isActive(n: SubagentNode): boolean {
  const state = agentStatusState(n)
  return state === "working" || state === "queued" || state === "paused"
}

/** Only working children need spinner redraws; a pause keeps the turn active, but static. */
export function isWorking(n: SubagentNode): boolean {
  return agentStatusState(n) === "working"
}

/**
 * Applies an event of the sub-agent's own session to its row: when it started, the tool it
 * runs, the tokens it used and what it said last.
 */
export function updateNode(node: SubagentNode, e: AnyEvent, presenters: PresenterSource | undefined): void {
  if (e.type === "session.start") {
    node.startedAt ??= e.ts
    node.queued = false
  } else if (e.type === "tool.execute.start") {
    node.activity = { name: e.data.name, summary: callSummary(presenters?.get(e.data.name), e.data.args) }
  } else if (e.type === "message.delta" && e.data.kind === "serverTool") {
    // The provider's own search, shown like a tool it runs.
    const { name, args } = serverToolCall(e.data.block)
    node.activity = { name, summary: callSummary(presenters?.get(name), args) }
  } else if (e.type === "message.end") {
    const u = e.data.message.usage
    if (u) node.tokens += u.input + u.output + u.cacheRead + u.cacheWrite
    const text = e.data.message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim()
    if (text) node.lastText = text
  }
}

/** The sub-agents `parent` started (through `callId`, when given), in start order. */
export function childrenOf(
  nodes: Map<string, SubagentNode>,
  parent: string,
  callId?: string,
): SubagentNode[] {
  return [...nodes.values()].filter(
    (n) => n.parent === parent && (callId === undefined || n.toolCallId === callId),
  )
}

/** A sub-agent and the ones under it, depth first, each after its parent. */
export function subtree(nodes: Map<string, SubagentNode>, n: SubagentNode): SubagentNode[] {
  return [n, ...childrenOf(nodes, n.id).flatMap((c) => subtree(nodes, c))]
}

/** A sub-agent's rows: live ones while it runs, its end line once it ended. */
export function nodeRows(
  n: SubagentNode,
  now: number,
  width: number,
  t: Theme,
  last = true,
  indent?: string,
  spinner?: string,
): string[] {
  return n.end
    ? [subagentEndLine(n, n.end, width, t, last, indent)]
    : subagentRows(n, now, width, t, last, indent, spinner)
}

/**
 * What started sub-agents that run without a call of this session, for the head over them:
 * their spawn group's name (a workflow, a swarm), else a command.
 */
export function backgroundLabel(groups: SpawnGroups | undefined, roots: SubagentNode[]): string {
  const of = roots.map((n) => (n.groupId !== undefined ? groups?.get(n.groupId) : undefined))
  // A compact group's own row names it already.
  if (of.length && of.every((g) => g?.compact)) return "in the background"
  const names = [...new Set(of.flatMap((g) => (g && !g.compact ? [g.name] : [])))]
  return names.length ? `${names.join(", ")} · in the background` : "started by a command · in the background"
}

/** Spawn groups of a session's tree, by id, as their latest event had them. */
export type SpawnGroups = Map<string, SpawnGroupInfo>

/** The group a sub-agent's row is folded into: one shown as a single line (SpawnGroupOptions.compact). */
export function compactGroup(groups: SpawnGroups | undefined, n: SubagentNode): SpawnGroupInfo | undefined {
  const g = n.groupId !== undefined ? groups?.get(n.groupId) : undefined
  return g?.compact ? g : undefined
}

type GroupOutcome = keyof NonNullable<SpawnGroupInfo["outcomes"]>
interface GroupMember {
  groups: Set<string>
  outcome?: GroupOutcome
}
interface GroupBaseline {
  outcomes: NonNullable<SpawnGroupInfo["outcomes"]>
  known: Set<string>
  /** Explicit outcomes whose individual end events have not been seen yet. */
  unmatched: NonNullable<SpawnGroupInfo["outcomes"]>
}
interface GroupTracking {
  members: Map<string, GroupMember>
  snapshots: SpawnGroups
  authoritative: Map<string, GroupBaseline>
}

/** Session-scoped handoff: rows may leave, but member identities and normalized outcomes do not. */
const groupTracking = new WeakMap<SpawnGroups, GroupTracking>()
function tracking(groups: SpawnGroups): GroupTracking {
  let state = groupTracking.get(groups)
  if (!state) {
    state = { members: new Map(), snapshots: new Map(), authoritative: new Map() }
    groupTracking.set(groups, state)
  }
  return state
}

function retainedGroup(group: SpawnGroupInfo, state: GroupTracking): SpawnGroupInfo {
  if (group.outcomes) return group
  const baseline = state.authoritative.get(group.id)
  const outcomes = { ...(baseline?.outcomes ?? { done: 0, failed: 0, stopped: 0 }) }
  // An explicit aggregate may already include end events that arrive later. Only its unknown
  // remainder can acquire additional outcomes; never count those delayed events twice.
  let remaining = baseline
    ? Math.max(0, group.agents.ended - outcomes.done - outcomes.failed - outcomes.stopped)
    : Number.POSITIVE_INFINITY
  const unmatched = { ...baseline?.unmatched }
  const additional: GroupOutcome[] = []
  for (const [id, member] of state.members) {
    if (!member.groups.has(group.id) || !member.outcome || baseline?.known.has(id)) continue
    const covered = unmatched[member.outcome] ?? 0
    if (covered) unmatched[member.outcome] = covered - 1
    else additional.push(member.outcome)
  }
  for (const outcome of additional) {
    if (!remaining) break
    outcomes[outcome]++
    remaining--
  }
  return { ...group, outcomes }
}

function groupBaseline(group: SpawnGroupInfo, state: GroupTracking): GroupBaseline {
  const outcomes = { ...group.outcomes! }
  const unmatched = { ...outcomes }
  const known = new Set<string>()
  const members = [...state.members].filter(([, m]) => m.groups.has(group.id) && m.outcome)
  for (const [id, member] of members) {
    if (!unmatched[member.outcome!]) continue
    unmatched[member.outcome!]--
    known.add(id)
  }
  // An explicit snapshot can correct previously seen results. Assign its remaining outcomes
  // to those known identities before treating any of them as as-yet-unseen end events.
  for (const [id] of members) {
    if (known.has(id)) continue
    const outcome = (Object.keys(unmatched) as GroupOutcome[]).find((key) => unmatched[key] > 0)
    if (!outcome) break
    unmatched[outcome]--
    known.add(id)
  }
  return { outcomes, unmatched, known }
}

function trackGroupNode(groups: SpawnGroups, node: SubagentNode): void {
  const state = tracking(groups)
  let member = state.members.get(node.id)
  if (!member) {
    // Capture ancestor membership while the parent is present, so nested groups still count
    // against their ancestors even if a parent row is no longer present.
    member = { groups: new Set(state.members.get(node.parent)?.groups) }
    if (node.groupId !== undefined) member.groups.add(node.groupId)
    state.members.set(node.id, member)
  }
  if (!node.end) return
  member.outcome = agentStatusState(node.end)
  for (const id of member.groups) {
    const snapshot = state.snapshots.get(id)
    if (snapshot) groups.set(id, retainedGroup(snapshot, state))
  }
}

/** Clears both rendered snapshots and their retained member handoff on a session boundary. */
export function resetGroups(groups: SpawnGroups): void {
  groups.clear()
  groupTracking.delete(groups)
}

/**
 * Records a group.* event; true when it changes what is shown (only a compact group's own line
 * shows it). Explicit outcomes are authoritative; legacy snapshots use the retained handoff.
 */
export function trackGroup(groups: SpawnGroups, e: AnyEvent): boolean {
  if (e.type !== "group.start" && e.type !== "group.update" && e.type !== "group.end") return false
  const group = e.data.group
  const state = tracking(groups)
  state.snapshots.set(group.id, group)
  if (group.outcomes) state.authoritative.set(group.id, groupBaseline(group, state))
  groups.set(group.id, retainedGroup(group, state))
  return group.compact === true
}

/** Core outcomes are definitive; legacy event sources can still use retained terminal nodes. */
function groupWithOutcomes(group: SpawnGroupInfo, list: SubagentNode[]): SpawnGroupInfo {
  if (group.outcomes) return group
  const outcomes = { done: 0, failed: 0, stopped: 0 }
  for (const n of list) {
    if (n.groupId !== group.id || !n.end) continue
    outcomes[agentStatusState(n.end)]++
  }
  return { ...group, outcomes }
}

/** Compact snapshots retain counts even after their terminal nodes have been discarded. */
export function subagentCounts(list: SubagentNode[], groups?: SpawnGroups): AgentCounts {
  const compact = new Map<string, SpawnGroupInfo>()
  const nodes = new Map(list.map((n) => [n.id, n]))
  const plain = list.filter((n) => {
    // A compact ancestor's snapshot includes its descendants, including their own groups.
    for (let parent = nodes.get(n.parent); parent; parent = nodes.get(parent.parent)) {
      if (compactGroup(groups, parent)) return false
    }
    const group = compactGroup(groups, n)
    if (!group) return true
    compact.set(group.id, groupWithOutcomes(group, list))
    return false
  })
  const counts = agentCounts(plain)
  for (const group of compact.values()) {
    const members = spawnGroupCounts(group)
    for (const key of Object.keys(counts) as (keyof AgentCounts)[]) counts[key] += members[key]
  }
  return counts
}

/** The background root must not turn mixed, failed, stopped or idle members into success. */
export function subagentGroupMark(
  list: SubagentNode[],
  groups: SpawnGroups | undefined,
  theme: Theme,
  spinner: string,
): string {
  return agentCountsMark(subagentCounts(list, groups), theme, spinner)
}

/**
 * Rows of a depth-first list of sub-agents, each closing its level ("└") when it is the last.
 * The members of a compact group (and theirs) are one row for the whole group, where its first
 * member would be. The legacy `closeTop` argument is retained for existing callers; child
 * trees always close independently of their owning call's continuation.
 */
export function treeRows(
  list: SubagentNode[],
  now: number,
  width: number,
  t: Theme,
  groups?: SpawnGroups,
  closeTop = true,
  spinner?: string,
): string[] {
  const items: (SubagentNode | { group: SpawnGroupInfo; depth: number })[] = []
  const folded = new Set<string>()
  for (const n of list) {
    const g = compactGroup(groups, n)
    if (!g) items.push(n)
    else if (!folded.has(g.id)) {
      folded.add(g.id)
      items.push({ group: groupWithOutcomes(g, list), depth: n.depth })
    }
  }
  const layout = treeLayout(items, closeTop)
  return items.flatMap((item, i) => {
    const { last, indent } = layout[i]!
    return "group" in item
      ? [spawnGroupRow(item.group, item.depth, width, t, last, indent, spinner)]
      : nodeRows(item, now, width, t, last, indent, spinner)
  })
}
