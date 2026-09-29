import { type AnyEvent, type EventEnvelope, fallbackTitle, type SpawnGroupInfo } from "@amira/api"
import type { Theme } from "@amira/tui-kit"
import { type SubagentLine, spawnGroupRow, subagentEndLine, subagentRows, treeLayout } from "./format.ts"
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
  /**
   * Its call was committed while it ran (inline): it returned at once (the sub-agent runs in
   * the background and a notice reports it) or it was cut short (its end line is committed alone).
   */
  detached?: "background" | "interrupted"
}

/** The node a subagent.start event describes, not placed anywhere yet. */
export function startedNode(e: EventEnvelope<"subagent.start">): SubagentNode {
  return {
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
}

/** Records a subagent.end event on its node. */
export function endNode(node: SubagentNode, e: EventEnvelope<"subagent.end">): void {
  node.end = {
    status: e.data.status,
    ...(e.data.error !== undefined ? { error: e.data.error } : {}),
    ...(e.data.note !== undefined ? { note: e.data.note } : {}),
    durationMs: e.data.durationMs,
    tokens: node.tokens,
  }
}

/**
 * Records a subagent.state event (a persistent sub-agent going idle between turns, or working
 * again). It comes with the parent's session id, so it is looked up by the child's.
 */
export function stateNode(node: SubagentNode, e: EventEnvelope<"subagent.state">): void {
  node.idle = e.data.state === "idle"
  // Its last tool belonged to the turn that ended.
  if (node.idle) delete node.activity
  if (e.data.state === "working") node.startedAt ??= e.ts
}

/** Whether a sub-agent's row still moves: started or queued, not ended, not idle between turns. */
export function isActive(n: SubagentNode): boolean {
  return !n.end && !n.idle
}

/**
 * Applies an event of the sub-agent's own session to its row: when it started, the tool it
 * runs, the tokens it used and what it said last.
 */
export function updateNode(node: SubagentNode, e: AnyEvent, presenters: PresenterSource | undefined): void {
  if (e.type === "session.start") node.startedAt ??= e.ts
  else if (e.type === "tool.execute.start") {
    node.activity = { name: e.data.name, summary: callSummary(presenters?.get(e.data.name), e.data.args) }
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

/** The call of `session` a sub-agent hangs under: its top ancestor's, when that is known. */
export function rootCall(
  nodes: Map<string, SubagentNode>,
  session: string,
  n: SubagentNode,
): string | undefined {
  let top = n
  while (top.parent !== session) {
    const up = nodes.get(top.parent)
    if (!up) return undefined
    top = up
  }
  return top.toolCallId
}

/** A sub-agent's rows: live ones while it runs, its end line once it ended. */
export function nodeRows(
  n: SubagentNode,
  now: number,
  width: number,
  t: Theme,
  last = true,
  indent?: string,
): string[] {
  return n.end
    ? [subagentEndLine(n, n.end, width, t, last, indent)]
    : subagentRows(n, now, width, t, last, indent)
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

/**
 * Records a group.* event; true when it changes what is shown (only a compact group's own line
 * shows it). False for other events.
 */
export function trackGroup(groups: SpawnGroups, e: AnyEvent): boolean {
  if (e.type !== "group.start" && e.type !== "group.update" && e.type !== "group.end") return false
  groups.set(e.data.group.id, e.data.group)
  return e.data.group.compact === true
}

/**
 * Rows of a depth-first list of sub-agents, each closing its level ("└") when it is the last.
 * The members of a compact group (and theirs) are one row for the whole group, where its first
 * member would be. With `closeTop` false, only a nested row can close a level (a finished
 * call's result line comes after them).
 */
export function treeRows(
  list: SubagentNode[],
  now: number,
  width: number,
  t: Theme,
  groups?: SpawnGroups,
  closeTop = true,
): string[] {
  const items: (SubagentNode | { group: SpawnGroupInfo; depth: number })[] = []
  const folded = new Set<string>()
  for (const n of list) {
    const g = compactGroup(groups, n)
    if (!g) items.push(n)
    else if (!folded.has(g.id)) {
      folded.add(g.id)
      items.push({ group: g, depth: n.depth })
    }
  }
  const layout = treeLayout(items, closeTop)
  return items.flatMap((item, i) => {
    const { last, indent } = layout[i]!
    return "group" in item
      ? [spawnGroupRow(item.group, item.depth, width, t, last, indent)]
      : nodeRows(item, now, width, t, last, indent)
  })
}
