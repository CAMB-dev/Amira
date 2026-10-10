import { truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { glyphs } from "../glyphs.ts"
import { backgroundLabel, isActive, type SubagentNode, subtree, treeRows } from "../subagents.ts"
import { treeContinuation } from "../tool-view.ts"
import { Block, type BlockEnv } from "./base.ts"

/**
 * Sub-agents started without a tool call of this session (by a command, say), under a small
 * head: one, or the members of one spawn group (a compact group's show as its one line).
 */
export class SubagentGroupBlock extends Block {
  readonly kind = "tool"
  running = true
  /** The sub-agents it shows, with theirs, in start order. */
  readonly roots: string[]

  #last = false

  /** Views mark the last tool/group in a run; changing it invalidates cached rows. */
  get last(): boolean {
    return this.#last
  }

  set last(value: boolean) {
    if (value === this.#last) return
    this.#last = value
    this.touch()
  }

  constructor(root: string) {
    super()
    this.roots = [root]
  }

  override get live(): boolean {
    return this.running
  }

  /** No tool call: what its head says. */
  override get label(): string {
    return "background sub-agents"
  }

  override subagents(env: BlockEnv): SubagentNode[] {
    return this.roots.flatMap((id) => {
      const node = env.nodes.get(id)
      return node ? subtree(env.nodes, node) : []
    })
  }

  lines(env: BlockEnv): string[] {
    const list = this.subagents(env)
    if (!list.length) return []
    this.running = list.some(isActive)
    const roots = this.roots.flatMap((id) => env.nodes.get(id) ?? [])
    const { theme, width } = env
    const arm = this.last ? glyphs.treeLast : glyphs.treeBranch
    const cells = Math.max(visibleWidth(glyphs.treeBranch), visibleWidth(glyphs.treeLast))
    const tree = theme.muted(arm + " ".repeat(cells - visibleWidth(arm)))
    const continuation = treeContinuation(theme, this.last)
    const treeWidth = Math.max(0, width - visibleWidth(continuation))
    const head = `  ${tree} ${this.running ? theme.accent(env.spinner) : theme.success(glyphs.subagentDone)} ${theme.muted(backgroundLabel(env.groups, roots))}`
    return [
      truncateToWidth(head, width, glyphs.more),
      ...treeRows(list, env.now, treeWidth, theme, env.groups, true, env.spinner).map((row) =>
        truncateToWidth(continuation + row, width, glyphs.more),
      ),
    ]
  }

  copyText(): string {
    return ""
  }
}
