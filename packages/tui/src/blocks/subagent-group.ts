import { truncateToWidth } from "@amira/tui-kit"
import { glyphs } from "../glyphs.ts"
import { backgroundLabel, isActive, type SubagentNode, subtree, treeRows } from "../subagents.ts"
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
    const head = `${env.theme.accent(glyphs.subagent)} ${env.theme.muted(backgroundLabel(env.groups, roots))}`
    return [
      truncateToWidth(head, env.width, glyphs.more),
      ...treeRows(list, env.now, env.width, env.theme, env.groups),
    ]
  }

  copyText(): string {
    return ""
  }
}
