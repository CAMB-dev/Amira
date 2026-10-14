import { formatElapsed, plural } from "@amira/api"
import { type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"
import { markerPrefix } from "./grid.ts"
import {
  backgroundLabel,
  type SpawnGroups,
  type SubagentNode,
  subagentGroupMark,
  subtree as subtreeOf,
  treeRows,
} from "./subagents.ts"
import { treeContinuation } from "./tool-view.ts"

interface BackgroundFrame {
  sessionId: string
  liveCalls: readonly { id: string }[]
  nodes: Map<string, SubagentNode>
  groups: SpawnGroups
  callNames: ReadonlyMap<string, string>
  spinner: string
  now: number
}

/** Durable group placement supplements live nodes, never reviving already committed groups. */
export function inlineDisplayNodes(
  live: ReadonlyMap<string, SubagentNode>,
  anchors: ReadonlyMap<string, { node: SubagentNode }>,
  committed: ReadonlySet<string>,
): Map<string, SubagentNode> {
  const nodes = new Map(live)
  for (const [id, { node }] of anchors) {
    if (committed.has(id)) {
      for (const member of nodes.values()) if (member.groupId === id) nodes.delete(member.id)
    } else if (![...nodes.values()].some((member) => member.groupId === id)) nodes.set(node.id, node)
  }
  return nodes
}

/** Background trees keep their placement and outcome presentation after their owning call leaves. */
export function inlineBackgroundRows(width: number, theme: Theme, frame: BackgroundFrame): string[] {
  const { sessionId, nodes, groups, callNames, spinner, now } = frame
  const live = new Set(frame.liveCalls.map((call) => call.id))
  const underCall = (node: SubagentNode) =>
    node.parent === sessionId && node.toolCallId !== undefined && live.has(node.toolCallId)
  const subtree = (node: SubagentNode) => subtreeOf(nodes, node)
  const roots = [...nodes.values()].filter((node) => !nodes.has(node.parent) && !underCall(node))
  if (!roots.length) return []
  // A committed call cannot change in place; its surviving children read as the call going on here.
  const byCall = new Map<string | undefined, SubagentNode[]>()
  for (const node of roots) byCall.set(node.toolCallId, [...(byCall.get(node.toolCallId) ?? []), node])
  const sep = ` ${theme.muted(glyphs.separator)} `
  const rows: string[] = []
  for (const [index, [callId, group]] of [...byCall].entries()) {
    const last = index === byCall.size - 1
    const arm = last ? glyphs.treeLast : glyphs.treeBranch
    const cells = Math.max(visibleWidth(glyphs.treeBranch), visibleWidth(glyphs.treeLast))
    const tree = theme.muted(arm + " ".repeat(cells - visibleWidth(arm)))
    const continuation = treeContinuation(theme, last)
    const treeWidth = Math.max(0, width - visibleWidth(continuation))
    const started = Math.min(...group.map((node) => node.startedAt ?? now))
    const count = plural(group.length, "sub-agent")
    const mark = subagentGroupMark(group.flatMap(subtree), groups, theme, spinner)
    const head =
      callId === undefined
        ? `${markerPrefix(tree)}${mark} ${theme.muted(backgroundLabel(groups, group))}`
        : `${markerPrefix(tree)}${mark} ${theme.fg2(callNames.get(callId) ?? "agent")}${sep}${count}${sep}${theme.muted(`running in background${sep}${formatElapsed(now - started)}`)}`
    rows.push(truncateToWidth(head, width, glyphs.more))
    rows.push(
      ...treeRows(group.flatMap(subtree), now, treeWidth, theme, groups, true, spinner).map((row) =>
        truncateToWidth(continuation + row, width, glyphs.more),
      ),
    )
  }
  return [...rows, ""]
}
