import type { OwnedConversation } from "@amira/api"
import type { AgentTree } from "./subagents.ts"

type Parent = { parentSessionId: string } | { info: { parentSessionId: string } }
type Scope = {
  live: ReadonlyMap<string, Parent>
  spawned: ReadonlyMap<string, Parent>
  disposing: ReadonlyMap<string, { parent: string }>
}

// Native presentation needs ownership, not a public listing or private child history.
const trees = new WeakMap<AgentTree, Scope>()
const conversations = new WeakMap<OwnedConversation, (sessionId: string) => boolean>()

export function registerSessionScope(
  tree: AgentTree,
  live: Scope["live"],
  spawned: Scope["spawned"],
  disposing: Scope["disposing"],
): void {
  trees.set(tree, { live, spawned, disposing })
}

export function sessionScopeContains(
  tree: AgentTree | undefined,
  sessionId: string,
  rootId: string,
): boolean {
  const scope = tree && trees.get(tree)
  if (!scope) return false
  const seen = new Set<string>()
  let current: string | undefined = sessionId
  while (current && !seen.has(current)) {
    if (current === rootId) return true
    seen.add(current)
    const parent: Parent | undefined = scope.live.get(current) ?? scope.spawned.get(current)
    current = parent
      ? "parentSessionId" in parent
        ? parent.parentSessionId
        : parent.info.parentSessionId
      : scope.disposing.get(current)?.parent
  }
  return false
}

export function registerConversationScope(
  conversation: OwnedConversation,
  contains: (sessionId: string) => boolean,
): void {
  conversations.set(conversation, contains)
}

/** Internal lookup works even when a descendant started before native focus subscribed. */
export function conversationScopeContains(conversation: OwnedConversation, sessionId: string): boolean {
  return conversation.id === sessionId || conversations.get(conversation)?.(sessionId) === true
}
