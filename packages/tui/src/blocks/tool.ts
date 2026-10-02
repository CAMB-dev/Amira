import {
  plural,
  type ToolApproval,
  type ToolDetailLevel,
  type ToolExploration,
  type ToolRejection,
  type ToolResult,
  toolResultText,
} from "@amira/api"
import { truncateToWidth } from "@amira/tui-kit"
import { glyphs } from "../glyphs.ts"
import { childrenOf, isActive, type SubagentNode, subtree, treeRows } from "../subagents.ts"
import {
  explorationOf,
  exploredLines,
  type FinishedCall,
  finishedToolLines,
  runningToolLines,
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

/** A tool call: its head, its output while it runs, then its result, with its sub-agents under it. */
export class ToolBlock extends Block {
  readonly kind = "tool"
  startedAt: number | undefined
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

  lines(env: BlockEnv): string[] {
    const tree = this.tree(env.nodes)
    this.running = this.started && (!this.end || tree.some(isActive))
    if (!this.started) return []
    const presenter = env.presenters?.get(this.name)
    const { theme, width, now } = env
    if (!this.end) {
      const call = {
        name: this.name,
        args: this.args,
        startedAt: this.startedAt!,
        ...(this.partial ? { partial: this.partial } : {}),
      }
      return [
        ...runningToolLines(theme, presenter, call, now, env.spinner, width),
        ...treeRows(tree, now, width, theme, env.groups),
      ]
    }
    const detail = this.detail(env)
    const opts = env.outputLines !== undefined ? { outputLines: env.outputLines } : {}
    const lines = finishedToolLines(theme, presenter, this.finished(), detail, width, opts)
    let rows: string[]
    if (detail === "collapsed" && this.folding === "collapsed" && tree.length) {
      const running = tree.filter(isActive).length
      // Counted as the head counts them, its own; theirs said apart.
      const own = tree.filter((n) => n.depth === tree[0]!.depth).length
      const nested = tree.length - own
      const text = `${plural(own, "sub-agent")}${nested ? ` (+${nested} nested)` : ""}${running ? ` · ${running} running` : ""}`
      rows = [
        truncateToWidth(
          `  ${theme.muted(glyphs.treeBranch)} ${theme.accent(glyphs.subagent)} ${theme.muted(text)}`,
          width,
          glyphs.more,
        ),
      ]
    } else {
      // The call's own result line comes after them, so only a nested one can close a level.
      rows = treeRows(tree, now, width, theme, env.groups, false)
    }
    lines.splice(1, 0, ...rows)
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

  copyText(): string {
    const head = `${this.name} ${JSON.stringify(this.args)}`
    if (!this.end) return head
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

  /** As the inline transcript shows it, or as unfolded by hand when that shows more. */
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

  /** What it only looked around for, once it succeeded: it can join an "Explored" row. */
  exploration(env: BlockEnv): ToolExploration | undefined {
    if (!this.end || this.tree(env.nodes).length) return undefined
    return explorationOf(env.presenters?.get(this.name), this.finished())
  }
}

/**
 * Successful calls in a row that only looked around (read, searched, listed files), as one
 * row: "● Explored · Read a.ts, b.ts · Search foo". Unfolded, each call under it.
 */
export class ExploredBlock extends Block {
  readonly kind = "tool"
  /** Set by folding it: how much of it shows, whatever the global level. */
  folding: ToolDetailLevel | undefined

  constructor(readonly calls: ToolBlock[]) {
    super()
  }

  private detail(env: BlockEnv): ToolDetailLevel {
    return this.folding ?? (env.detail === "full" ? "full" : "summary")
  }

  lines(env: BlockEnv): string[] {
    const opts = env.outputLines !== undefined ? { outputLines: env.outputLines } : {}
    const calls = this.calls.map((b) => ({ call: b.finished(), presenter: env.presenters?.get(b.name) }))
    // Unfolded, each call shows as calls do now (all of it at the "full" level).
    const expanded = this.detail(env) === "full"
    const each = env.detail === "full" ? "full" : "summary"
    return exploredLines(env.theme, calls, expanded, each, env.width, opts)
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

  /** As the inline transcript shows it, or as unfolded by hand when that shows more. */
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
  return b instanceof ExploredBlock || (b instanceof ToolBlock && b.exploration(env) !== undefined)
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
      out[out.length - 1] = new ExploredBlock(calls)
    } else out.push(b)
  }
  return out
}
