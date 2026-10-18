import type { OwnedConversation } from "@amira/api"
import type { Agent } from "./agent.ts"
import type { EventBus } from "./event-bus.ts"
import type { AgentTree } from "./subagents.ts"

const agents = new Map<string, WeakRef<Agent>>()
const busAgents = new WeakMap<EventBus, WeakRef<Agent>>()

/** Host authority exists before any frontend or native conversation focus attaches. */
export function registerAgentSession(agent: Agent): void {
  const reference = new WeakRef(agent)
  agents.set(agent.sessionId, reference)
  if (!busAgents.get(agent.bus)?.deref()) busAgents.set(agent.bus, reference)
}

/** Disposal must not unregister a newer Agent using the same durable session identity. */
export function unregisterAgentSession(agent: Agent): void {
  if (agents.get(agent.sessionId)?.deref() === agent) agents.delete(agent.sessionId)
  if (busAgents.get(agent.bus)?.deref() === agent) busAgents.delete(agent.bus)
}

/** Whether `agent` still holds its session id, rather than a newer Agent for the same session. */
export function holdsAgentSession(agent: Agent): boolean {
  return agents.get(agent.sessionId)?.deref() === agent
}

/** A successfully selected root, not a merely constructed candidate, owns host-default requests. */
export function activateAgentSession(agent: Agent): void {
  busAgents.set(agent.bus, new WeakRef(agent))
}

/** Capture the root turn now; callers retain only identity, never the Agent itself. */
export function sessionTurnOwner(
  sessionId: string,
  bus: EventBus,
): { sessionId: string; turnId?: string; conversationIncarnation?: string } | undefined {
  let agent = (sessionId === "host" ? busAgents.get(bus) : agents.get(sessionId))?.deref()
  const seen = new Set<string>()
  while (agent?.parentSessionId && !seen.has(agent.sessionId)) {
    seen.add(agent.sessionId)
    const parent = agents.get(agent.parentSessionId)?.deref()
    if (!parent) break
    agent = parent
  }
  if (!agent) return undefined
  const incarnation = actorIncarnations.get(agent)
  return {
    sessionId: agent.sessionId,
    turnId: agent.turnId,
    ...(incarnation ? { conversationIncarnation: incarnation } : {}),
  }
}

type Parent = { parentSessionId: string } | { info: { parentSessionId: string } }
type Scope = {
  live: ReadonlyMap<string, Parent>
  spawned: ReadonlyMap<string, Parent>
  disposing: ReadonlyMap<string, { parent: string }>
}

// Native presentation needs ownership, not a public listing or private child history.
const trees = new WeakMap<AgentTree, Scope>()
const conversations = new WeakMap<OwnedConversation, (sessionId: string) => boolean>()
const conversationTurns = new WeakMap<OwnedConversation, () => string | undefined>()
const conversationHolds = new WeakMap<OwnedConversation, () => string | undefined>()
type Send = (
  text: string,
  options: Parameters<OwnedConversation["send"]>[1],
  turnId?: string,
) => Promise<void>
const conversationSends = new WeakMap<OwnedConversation, Send>()
const incarnations = new WeakMap<OwnedConversation, string>()
const revoked = new WeakSet<OwnedConversation>()
const actorIncarnations = new WeakMap<Agent, string>()

/** Issued by the host for one live handle, never derived from its durable conversation ID. */
export function conversationIncarnation(conversation: OwnedConversation): string {
  let token = incarnations.get(conversation)
  if (!token) {
    token = crypto.randomUUID()
    incarnations.set(conversation, token)
  }
  return token
}

export function isConversationIncarnation(conversation: OwnedConversation, token: string): boolean {
  return !revoked.has(conversation) && incarnations.get(conversation) === token
}

export function releaseConversationIncarnation(conversation: OwnedConversation): void {
  revoked.add(conversation)
}

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
  agent?: Agent,
): void {
  conversations.set(conversation, contains)
  const token = conversationIncarnation(conversation)
  if (agent) actorIncarnations.set(agent, token)
}

/** Internal turn authority: never widens the public OwnedConversation status/stop contract. */
export function registerConversationTurn(
  conversation: OwnedConversation,
  current: () => string | undefined,
): void {
  conversationTurns.set(conversation, current)
}

export function conversationTurnId(conversation: OwnedConversation): string | undefined {
  return conversationTurns.get(conversation)?.()
}

export function registerConversationHold(
  conversation: OwnedConversation,
  current: () => string | undefined,
): void {
  conversationHolds.set(conversation, current)
}

export function conversationHoldId(conversation: OwnedConversation): string | undefined {
  return conversationHolds.get(conversation)?.()
}

/** Internal admission identity; the extension-facing send API remains unchanged. */
export function registerConversationSend(conversation: OwnedConversation, send: Send): void {
  conversationSends.set(conversation, send)
}

export function sendConversation(
  conversation: OwnedConversation,
  text: string,
  options: Parameters<OwnedConversation["send"]>[1],
  turnId?: string,
): Promise<void> {
  const send = conversationSends.get(conversation)
  return send ? send(text, options, turnId) : conversation.send(text, options)
}

/** Internal lookup works even when a descendant started before native focus subscribed. */
export function conversationScopeContains(conversation: OwnedConversation, sessionId: string): boolean {
  return conversation.id === sessionId || conversations.get(conversation)?.(sessionId) === true
}
