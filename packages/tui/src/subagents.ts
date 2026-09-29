import { type AnyEvent, type EventEnvelope, fallbackTitle } from "@amira/api"
import type { Theme } from "@amira/tui-kit"
import { isLastSibling, type SubagentLine, subagentEndLine, subagentRows } from "./format.ts"
import { callSummary, type PresenterSource } from "./tool-view.ts"

/** A sub-agent the UI follows: its row, where it hangs, and how it ended once it did. */
export interface SubagentNode extends SubagentLine {
  id: string
  /** The session that started it: the main one, or another sub-agent's. */
  parent: string
  /** The call of `parent` that started it. */
  toolCallId?: string
  end?: { status: "done" | "error" | "aborted"; error?: string; durationMs: number; tokens: number }
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
    durationMs: e.data.durationMs,
    tokens: node.tokens,
  }
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
export function nodeRows(n: SubagentNode, now: number, width: number, t: Theme, last = true): string[] {
  return n.end ? [subagentEndLine(n, n.end, width, t, last)] : subagentRows(n, now, width, t, last)
}

/** Rows of a depth-first list of sub-agents, each closing its level ("└") when it is the last. */
export function treeRows(list: SubagentNode[], now: number, width: number, t: Theme): string[] {
  return list.flatMap((n, i) => nodeRows(n, now, width, t, isLastSibling(list, i)))
}
