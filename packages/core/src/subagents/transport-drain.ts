import type { ModelError } from "@amira/ai"
import type { AgentTree } from "../subagents.ts"
import type { Child } from "./child.ts"
import { scopeAdmission } from "./lifecycle.ts"

const draining = new WeakSet<Child>()

/** An explicit abort still interrupts tools, even while normal failure teardown is draining. */
export function abortNetworkDrain(tree: AgentTree, child: Child, reason: string): void {
  if (draining.has(child)) tree.abortChildren(child.id, reason)
}

/** Close the failed subtree to new model work, then let its already-running tool batches settle. */
export async function drainNetworkChildren(
  tree: AgentTree,
  parent: Child,
  live: Iterable<Child>,
  error: string | undefined,
): Promise<void> {
  const children = new Map([...live].map((child) => [child.id, child]))
  const descendants = [...children.values()].filter((child) => {
    for (let id: string | undefined = child.parentSessionId; id; id = children.get(id)?.parentSessionId) {
      if (id === parent.id) return true
    }
    return false
  })
  const failure: ModelError = { kind: "network", message: error ?? "its parent's model connection was lost" }
  // Mark the entire subtree before waking anybody: no released waiter may admit another model call.
  for (const child of [parent, ...descendants]) {
    draining.add(child)
    scopeAdmission(tree).closeParent(child.id)
    child.agent.cancelNoticeRetry()
    child.agent.execution.failModel(failure)
  }
  if (parent.abortReason) tree.abortChildren(parent.id, parent.abortReason)
  for (const child of descendants) {
    if (!child.started) tree.abortChild(child, "its parent's model connection was lost")
    else if (child.persistent) tree.stopChild(child, "its parent's model connection was lost")
  }
  await Promise.all(descendants.map((child) => child.result()))
  await tree.waitForChildren(parent.id)
}
