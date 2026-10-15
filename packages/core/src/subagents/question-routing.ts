import type { Agent, AgentOptions } from "../agent.ts"
import type { AgentTree } from "../subagents.ts"
import type { ParentConsultant } from "./consult-parent.ts"
import { approveWithHost } from "./host-approval.ts"

const humanRoutedTrees = new WeakSet<AgentTree>()

/** Internal owner policy, separate from the public research-only execution restriction. */
export function routeTreeToHuman(tree: AgentTree): void {
  humanRoutedTrees.add(tree)
}

export function hasHumanRouting(tree: AgentTree): boolean {
  return humanRoutedTrees.has(tree)
}

/** Owner routing is independent of research-only shell/cwd restrictions. */
export function childQuestionRouting(
  parent: Agent,
  consultant: ParentConsultant,
  directHuman: boolean,
): Pick<AgentOptions, "ask" | "approve"> {
  return {
    approve: (request, signal) =>
      directHuman ? approveWithHost(parent, request, signal) : consultant.approve(parent, request, signal),
    ask: (request, signal) =>
      directHuman ? parent.askQuestions(request, signal) : consultant.ask(parent, request, signal),
  }
}
