import type { AnyEvent } from "@amira/api"
import type { Block } from "../blocks/base.ts"
import { SubagentGroupBlock } from "../blocks/subagent-group.ts"
import type { ToolBlock } from "../blocks/tool.ts"
import {
  endNode,
  isActive,
  type SpawnGroups,
  type SubagentNode,
  startedNode,
  stateNode,
  trackGroup,
  updateNode,
} from "../subagents.ts"
import type { NoticeLevel } from "../transcript.ts"
import type { ViewHost } from "../view.ts"

export interface SubagentBlocksDeps {
  sessionId: () => string
  callBlock: (toolCallId: string) => ToolBlock | undefined
  add: (block: Block) => void
  requestRender: () => void
  notice: (level: NoticeLevel, text: string) => void
  presenters: ViewHost["presenters"]
}

export function createSubagentBlocks(deps: SubagentBlocksDeps) {
  const { sessionId, callBlock, add, requestRender, notice } = deps
  /** Every sub-agent seen, by id; tool calls draw theirs from here. */
  const nodes = new Map<string, SubagentNode>()
  /** Spawn groups of the sub-agents seen, as their latest event had them. */
  const groups: SpawnGroups = new Map()
  /** The block each sub-agent shows in, by its id: the call that started it (or its top ancestor), or one of its own. */
  const owners = new Map<string, Block>()
  /** The block of each spawn group whose members started without a call of this session. */
  const groupBlocks = new Map<string, SubagentGroupBlock>()

  /** Redraws once a second while sub-agents run, so their elapsed time moves. */
  let subagentTimer: ReturnType<typeof setInterval> | undefined
  const tick = () => {
    const running = [...nodes.values()].some(isActive)
    if (running && !subagentTimer) subagentTimer = setInterval(() => requestRender(), 1000)
    else if (!running && subagentTimer) {
      clearInterval(subagentTimer)
      subagentTimer = undefined
    }
  }

  /** The block a sub-agent shows in: its top ancestor's call, or a block of its own. */
  const ownerOf = (n: SubagentNode): Block | undefined => owners.get(n.id)

  function event(e: AnyEvent): boolean {
    const mine = e.sessionId === sessionId() || nodes.has(e.sessionId)
    switch (e.type) {
      case "subagent.start": {
        if (!mine) return false
        const node = startedNode(e)
        nodes.set(node.id, node)
        const main = node.parent === sessionId()
        const call = main && node.toolCallId ? callBlock(node.toolCallId) : undefined
        const owner = owners.get(node.parent) ?? call
        if (owner) {
          owners.set(node.id, owner)
          owner.touch()
        } else if (main) {
          // Started without a call of this session (by a command, say): a block of its own,
          // shared by the members of its spawn group (a workflow's agents, a swarm's members).
          const shared = node.groupId !== undefined ? groupBlocks.get(node.groupId) : undefined
          if (shared) {
            shared.roots.push(node.id)
            owners.set(node.id, shared)
            shared.touch()
          } else {
            const group = new SubagentGroupBlock(node.id)
            owners.set(node.id, group)
            if (node.groupId !== undefined) groupBlocks.set(node.groupId, group)
            add(group)
          }
        }
        break
      }
      case "subagent.end": {
        const node = nodes.get(e.data.childSessionId)
        if (!node) return false
        endNode(node, e)
        ownerOf(node)?.touch()
        break
      }
      case "subagent.state": {
        const node = nodes.get(e.data.childSessionId)
        if (!node) return false
        stateNode(node, e)
        ownerOf(node)?.touch()
        break
      }
      case "group.start":
      case "group.update":
      case "group.end": {
        if (!mine || !trackGroup(groups, e)) return false
        // A compact group's line is drawn by the blocks its members show in.
        for (const n of nodes.values()) if (n.groupId === e.data.group.id) ownerOf(n)?.touch()
        requestRender()
        return true
      }
      case "budget.exceeded":
        notice("warning", `Budget spent (${e.data.tokens} tokens); sub-agents were stopped.`)
        return true
      default: {
        const node = nodes.get(e.sessionId)
        if (!node) return false
        updateNode(node, e, deps.presenters)
        ownerOf(node)?.touch()
        return true
      }
    }
    tick()
    return true
  }

  function reset(): void {
    nodes.clear()
    groups.clear()
    owners.clear()
    groupBlocks.clear()
    tick()
  }

  function stop(): void {
    if (subagentTimer) clearInterval(subagentTimer)
    subagentTimer = undefined
  }

  return {
    get nodes() {
      return nodes
    },
    get groups() {
      return groups
    },
    event,
    tick,
    reset,
    stop,
  }
}
