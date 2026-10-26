import {
  plural,
  type ToolApproval,
  type ToolDetailLevel,
  type ToolExploration,
  type ToolRejection,
  type ToolResult,
  toolResultText,
} from "@amira/api"
import { stripAnsi, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { agentCountsMark, agentCountsText, timestampIn } from "../format.ts"
import { glyphs, viewEllipsis } from "../glyphs.ts"
import { markerPrefix } from "../grid.ts"
import { childrenOf, isActive, type SubagentNode, subagentCounts, subtree, treeRows } from "../subagents.ts"
import { type CopyRow, chromeRows, sliceCells } from "../text-selection.ts"
import {
  explorationOf,
  exploredLines,
  type FinishedCall,
  finishedToolLines,
  runningToolLines,
  treeContinuation,
} from "../tool-view.ts"
import { Block, type BlockEnv } from "./base.ts"

/** How much a folded block shows next, from what it shows now: summary, then all, then least. */
const NEXT_DETAIL: Record<ToolDetailLevel, ToolDetailLevel> = {
  summary: "full",
  full: "collapsed",
  collapsed: "summary",
}

/** How much each tool output level shows, least first. */
const DETAIL_RANK: Record<ToolDetailLevel, number> = { collapsed: 0, summary: 1, full: 2 }

/** Only the renderer knows which columns are chrome and how a continuation joins. */
const rowContent = new WeakMap<readonly string[], ReadonlyMap<number, CopyRow>>()

function rowRecorder() {
  const rows = new Map<number, CopyRow>()
  const rowAt = (row: number) => {
    let value = rows.get(row)
    if (!value) {
      value = { from: 0 }
      rows.set(row, value)
    }
    return value
  }
  return {
    rows,
    onRow: (row: number, from: number) => {
      rowAt(row).from = from
    },
    onWrap: (row: number, join: "" | " ") => {
      rowAt(row).joinBefore = join
    },
  }
}

function contentRows(plain: readonly string[], lines: readonly string[]): CopyRow[] {
  const content = rowContent.get(lines)
  return plain.map((_, i) => content?.get(i) ?? { from: 0 })
}

/** A tool call: its head, its output while it runs, then its result, with its sub-agents under it. */
export class ToolBlock extends Block {
  readonly kind = "tool"
  startedAt: number | undefined
  timestamp: number | undefined
  partial: ToolResult | undefined
  end:
    | {
        result: ToolResult
        durationMs?: number
        rejected?: ToolRejection
        interrupted?: boolean
        approval?: ToolApproval
      }
    | undefined
  /** Set by folding it: how much of it shows, whatever the global level. */
  folding: ToolDetailLevel | undefined

  #last = false

  /** Views mark the last tool in a step/turn; changing it invalidates cached rows. */
  get last(): boolean {
    return this.#last
  }

  set last(value: boolean) {
    if (value === this.#last) return
    this.#last = value
    this.touch()
  }

  constructor(
    readonly callId: string,
    public name: string,
    public args: Record<string, unknown>,
    /** The session that made the call; its sub-agents are found by it. */
    readonly session: string,
  ) {
    super()
  }

  /** A call the reply asked for but that did not start yet takes no room. */
  get started(): boolean {
    return this.startedAt !== undefined || this.end !== undefined
  }

  /** Whether it or one of its sub-agents still runs. Checked against the nodes when drawn. */
  running = false

  override get live(): boolean {
    return this.running
  }

  /** The sub-agents it started, and theirs, depth first. */
  tree(nodes: Map<string, SubagentNode>): SubagentNode[] {
    return childrenOf(nodes, this.session, this.callId).flatMap((n) => subtree(nodes, n))
  }

  detail(env: BlockEnv): ToolDetailLevel {
    return this.folding ?? env.detail
  }

  /** A question being asked shows as its dialog, not as a running call. */
  hidden(env: Pick<BlockEnv, "askDialogVisible">): boolean {
    return !this.end && this.name === "ask_user" && !!env.askDialogVisible
  }

  override cacheVersion(env: BlockEnv): number | string {
    return this.hidden(env) ? `${this.version}:ask-dialog` : this.version
  }

  lines(env: BlockEnv): string[] {
    const tree = this.tree(env.nodes)
    this.running = this.started && (!this.end || tree.some(isActive))
    if (!this.started || this.hidden(env)) return []
    const presenter = env.presenters?.get(this.name)
    const { theme, width, now } = env
    const continuation = treeContinuation(theme, this.last)
    const treeWidth = Math.max(0, width - visibleWidth(continuation))
    const nested = (rows: string[]) =>
      rows.map((row) => truncateToWidth(`${continuation}${row}`, width, viewEllipsis()))
    const record = rowRecorder()
    if (!this.end) {
      const call = {
        name: this.name,
        args: this.args,
        startedAt: this.startedAt!,
        ...(this.partial ? { partial: this.partial } : {}),
      }
      const rows = runningToolLines(theme, presenter, call, now, env.spinner, width, {
        timestamp: this.timestamp,
        liveOutputLines: env.liveOutputLines,
        onRow: record.onRow,
      })
      rows.push(...nested(treeRows(tree, now, treeWidth, theme, env.groups, true, env.spinner)))
      rowContent.set(rows, record.rows)
      return rows
    }
    const detail = this.detail(env)
    const opts = {
      last: this.last,
      timestamp: this.timestamp,
      ...(env.outputLines !== undefined ? { outputLines: env.outputLines } : {}),
      onRow: record.onRow,
      onWrap: record.onWrap,
    }
    const lines = finishedToolLines(theme, presenter, this.finished(), detail, width, opts)
    let rows: string[]
    if (detail === "collapsed" && this.folding === "collapsed" && tree.length) {
      const counts = subagentCounts(tree, env.groups)
      // Counted as the head counts them, its own; theirs said apart.
      const own = tree.filter((n) => n.depth === tree[0]!.depth).length
      const nested = tree.length - own
      const members =
        counts.total === tree.length
          ? `${plural(own, "sub-agent")}${nested ? ` (+${nested} nested)` : ""}`
          : plural(counts.total, "sub-agent")
      const text = `${members} ${glyphs.separator} ${agentCountsText(counts)}`
      rows = [
        truncateToWidth(
          `${markerPrefix(theme.muted(glyphs.treeLast))}${agentCountsMark(counts, theme, env.spinner)} ${theme.muted(text)}`,
          treeWidth,
          viewEllipsis(),
        ),
      ]
    } else {
      // The child tree closes independently of the call's own result/output continuation.
      rows = treeRows(tree, now, treeWidth, theme, env.groups, true, env.spinner)
    }
    lines.splice(1, 0, ...nested(rows))
    rowContent.set(
      lines,
      new Map([...record.rows].map(([row, content]) => [row === 0 ? 0 : row + rows.length, content])),
    )
    return lines
  }

  finished(): FinishedCall {
    const end = this.end!
    return {
      name: this.name,
      args: this.args,
      result: end.result,
      ...(end.durationMs !== undefined ? { durationMs: end.durationMs } : {}),
      ...(end.rejected ? { rejected: end.rejected } : {}),
      ...(end.approval ? { approval: end.approval } : {}),
      interrupted: end.interrupted ?? false,
    }
  }

  override copyRows(plain: readonly string[], lines: readonly string[] = plain): CopyRow[] {
    const rows = chromeRows(plain)
    const stamp = timestampIn(lines)
    if (stamp) rows[stamp.line]!.to = stamp.to
    for (const [i, content] of rowContent.get(lines) ?? []) Object.assign(rows[i]!, content)
    return rows
  }

  override searchRows(plain: readonly string[], lines: readonly string[]): CopyRow[] {
    return contentRows(plain, lines)
  }

  copyText(env?: BlockEnv): string {
    const head = `${this.name} ${JSON.stringify(this.args)}`
    if (!this.end) return head
    if (env && this.detail(env) === "full") {
      const presenter = env.presenters?.get(this.name)
      const view = { args: this.args, result: this.end.result, text: toolResultText(this.end.result) }
      try {
        // Choice transcripts retain their offered options and marks when copied unfolded.
        const body = presenter?.body?.(view, { detail: "full", width: env.width })
        if (body?.some((line) => line.marker)) {
          const lines = this.lines(env)
          const plain = lines.map(stripAnsi)
          const rows = this.copyRows(plain, lines)
          return plain
            .map((row, i) =>
              sliceCells(row, rows[i]!.from, rows[i]!.to ?? Number.POSITIVE_INFINITY).trimEnd(),
            )
            .join("\n")
        }
      } catch {
        // As when rendering, a broken presenter falls back to the stored output.
      }
    }
    return `${head}\n${toolResultText(this.end.result)}`.trim()
  }

  override foldable(): boolean {
    return this.end !== undefined
  }

  override toggleFold(env: BlockEnv): void {
    // Around the three levels; back at the one everything shows, it follows that one again.
    const next = NEXT_DETAIL[this.detail(env)]
    this.folding = next === env.detail ? undefined : next
    this.touch()
  }

  override isFolded(env: BlockEnv): boolean {
    return this.detail(env) !== "full"
  }

  override subagents(env: BlockEnv): SubagentNode[] {
    return this.tree(env.nodes)
  }

  override get refolded(): boolean {
    return this.folding !== undefined
  }

  /** Default-detail output, or as unfolded by hand when that shows more. */
  override printLines(env: BlockEnv): string[] {
    if (!this.end) return this.lines({ ...env, liveOutputLines: 0 })
    const folding = this.folding
    if (folding && DETAIL_RANK[folding] > DETAIL_RANK[env.detail]) return this.lines(env)
    this.folding = undefined
    try {
      return this.lines(env)
    } finally {
      this.folding = folding
    }
  }

  /** What it only looked around for, once it succeeded: it can join an "Explored" row. */
  exploration(env: BlockEnv): ToolExploration | undefined {
    if (!this.end || this.tree(env.nodes).length) return undefined
    return explorationOf(env.presenters?.get(this.name), this.finished())
  }
}

/**
 * Successful calls in a row that only looked around (read, searched, listed files), as one
 * row: "├ Read 2 files (a.ts, b.ts)  ▸". Unfolded, each call and its full output.
 */
export class ExploredBlock extends Block {
  readonly kind = "tool"
  /** Set by folding it: how much of it shows, whatever the global level. */
  folding: ToolDetailLevel | undefined

  #last = false

  /** Views mark the last tool in a step/turn; changing it invalidates cached rows. */
  get last(): boolean {
    return this.#last
  }

  set last(value: boolean) {
    if (value === this.#last) return
    this.#last = value
    this.touch()
  }

  constructor(readonly calls: ToolBlock[]) {
    super()
  }

  get timestamp(): number | undefined {
    return this.calls.find((call) => call.timestamp !== undefined)?.timestamp
  }

  override copyRows(plain: readonly string[], lines: readonly string[] = plain): CopyRow[] {
    const rows = chromeRows(plain)
    const stamp = timestampIn(lines)
    if (stamp) rows[stamp.line]!.to = stamp.to
    for (const [i, content] of rowContent.get(lines) ?? []) Object.assign(rows[i]!, content)
    return rows
  }

  override searchRows(plain: readonly string[], lines: readonly string[]): CopyRow[] {
    return contentRows(plain, lines)
  }

  private detail(env: BlockEnv): ToolDetailLevel {
    return this.folding ?? (env.detail === "full" ? "full" : "summary")
  }

  lines(env: BlockEnv): string[] {
    const record = rowRecorder()
    const opts = {
      last: this.last,
      timestamp: this.timestamp,
      ...(env.outputLines !== undefined ? { outputLines: env.outputLines } : {}),
      onRow: record.onRow,
      onWrap: record.onWrap,
    }
    const calls = this.calls.map((b) => ({ call: b.finished(), presenter: env.presenters?.get(b.name) }))
    // Unfolded, each call shows as calls do now (all of it at the "full" level).
    const expanded = this.detail(env) === "full"
    const each = expanded ? "full" : "summary"
    const rows = exploredLines(env.theme, calls, expanded, each, env.width, opts)
    rowContent.set(rows, record.rows)
    return rows
  }

  copyText(): string {
    return this.calls.map((b) => b.copyText()).join("\n\n")
  }

  override foldable(): boolean {
    return true
  }

  override toggleFold(env: BlockEnv): void {
    const next = this.detail(env) === "full" ? "summary" : "full"
    this.folding = next === (env.detail === "full" ? "full" : "summary") ? undefined : next
    this.touch()
  }

  override isFolded(env: BlockEnv): boolean {
    return this.detail(env) !== "full"
  }

  override get refolded(): boolean {
    return this.folding !== undefined
  }

  /** Default-detail output, or as unfolded by hand when that shows more. */
  override printLines(env: BlockEnv): string[] {
    const folding = this.folding
    if (folding && DETAIL_RANK[folding] > DETAIL_RANK[env.detail]) return this.lines(env)
    this.folding = undefined
    try {
      return this.lines(env)
    } finally {
      this.folding = folding
    }
  }
}

/** Whether a block can be part of an "Explored" row: an exploring call that succeeded, or such a row. */
function explores(b: Block | undefined, env: BlockEnv): b is ToolBlock | ExploredBlock {
  return b instanceof ExploredBlock
    ? b.calls.every((call) => call.exploration(env) !== undefined)
    : b instanceof ToolBlock && b.exploration(env) !== undefined
}

/**
 * Makes the run of exploring blocks around `block` in `list` one "Explored" block, when it is
 * more than one call. Returns what to do to the list: the block to put in, and the blocks it
 * replaces (in order); undefined when nothing changes.
 */
export function exploredRun(
  list: readonly Block[],
  block: Block,
  env: BlockEnv,
): { group: ExploredBlock; replaces: Block[] } | undefined {
  const at = list.indexOf(block)
  if (at < 0 || !explores(block, env)) return undefined
  let from = at
  let to = at
  while (from > 0 && explores(list[from - 1], env)) from--
  while (to + 1 < list.length && explores(list[to + 1], env)) to++
  const run = list.slice(from, to + 1) as (ToolBlock | ExploredBlock)[]
  if (run.length < 2) return undefined
  const calls = run.flatMap((b) => (b instanceof ExploredBlock ? b.calls : [b]))
  const group = new ExploredBlock(calls)
  group.last = run[run.length - 1]!.last
  // A row the user folded keeps how it was folded.
  const folded = run.find((b): b is ExploredBlock => b instanceof ExploredBlock && b.folding !== undefined)
  if (folded) group.folding = folded.folding
  return { group, replaces: run }
}

/** Blocks with each run of exploring calls made one "Explored" block, e.g. for a resumed history. */
export function groupExplored(list: Block[], env: BlockEnv): Block[] {
  const out: Block[] = []
  for (const b of list) {
    const prev = out[out.length - 1]
    if (prev && explores(prev, env) && explores(b, env)) {
      const calls = [
        ...(prev instanceof ExploredBlock ? prev.calls : [prev]),
        ...(b instanceof ExploredBlock ? b.calls : [b]),
      ]
      const group = new ExploredBlock(calls)
      group.last = b.last
      out[out.length - 1] = group
    } else out.push(b)
  }
  return out
}
