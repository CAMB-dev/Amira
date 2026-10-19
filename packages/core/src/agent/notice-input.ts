// Host-only notice recovery state; deliberately not an EventMap event or Agent capability.
import type { UserMessage } from "@amira/ai"
import type { Agent } from "../agent.ts"
import type { EventBus } from "../event-bus.ts"
import { holdsAgentSession } from "../session-routing.ts"
import { registerHeldInput as registerHold } from "./held-input.ts"
import type { SessionHold } from "./hold.ts"
import { registerNoticeRetry } from "./notice-retry.ts"
import type { NoticeInbox } from "./notices.ts"
import { registerSteeringInput } from "./steering-input.ts"

export { steeringInputSnapshot } from "./steering-input.ts"

export interface NoticeInput {
  /** Equal delivered messages still occupy distinct inbox admissions. */
  readonly id: string
  readonly message: UserMessage
}

export interface NoticeInputSnapshot {
  readonly queue: readonly NoticeInput[]
  readonly expected: number
}

type Listener = {
  changed: (snapshot: NoticeInputSnapshot) => void
  failed: (error: unknown) => void
}
interface State {
  snapshot: NoticeInputSnapshot
  listeners: Set<Listener>
  owner?: WeakRef<Agent>
  source?: () => NoticeInputSnapshot
}
type BusListener = {
  changed: (agent: Agent, snapshot: NoticeInputSnapshot) => void
  failed: Listener["failed"]
}
interface BusState {
  agents: Set<WeakRef<Agent>>
  listeners: Set<BusListener>
}
const states = new WeakMap<Agent | NoticeInbox, State>()
const buses = new WeakMap<EventBus, BusState>()
const collected = new FinalizationRegistry<{ agents: BusState["agents"]; owner: WeakRef<Agent> }>(
  ({ agents, owner }) => agents.delete(owner),
)

function busState(bus: EventBus): BusState {
  let value = buses.get(bus)
  if (!value) {
    value = { agents: new Set(), listeners: new Set() }
    buses.set(bus, value)
  }
  return value
}

function state(owner: Agent | NoticeInbox): State {
  let value = states.get(owner)
  if (!value) {
    value = { snapshot: Object.freeze({ queue: Object.freeze([]), expected: 0 }), listeners: new Set() }
    states.set(owner, value)
  }
  return value
}

/** Extend the existing owner registration without exposing the private inbox publicly. */
export function registerHeldInput(
  agent: Agent,
  hold: SessionHold,
  inbox: NoticeInbox,
  steering?: () => readonly UserMessage[],
): void {
  registerHold(agent, hold)
  if (steering) registerSteeringInput(agent, steering)
  registerNoticeRetry(agent, inbox)
  const value = state(inbox)
  value.source = () => inbox.recoveryState()
  states.set(agent, value)
  const owner = new WeakRef(agent)
  value.owner = owner
  const agents = busState(agent.bus).agents
  agents.add(owner)
  collected.register(agent, { agents, owner }, owner)
}

/** Live bus owners, including inboxes created before host capture subscribed. No strong registry. */
export function noticeInputAgents(bus: EventBus): readonly Agent[] {
  const agents = busState(bus).agents
  const live: Agent[] = []
  for (const owner of agents) {
    const agent = owner.deref()
    if (agent && holdsAgentSession(agent)) live.push(agent)
    else {
      agents.delete(owner)
      collected.unregister(owner)
    }
  }
  return live
}

/** Bus-scoped host capture includes descendants and not-yet-selected replacement roots.
 * Private children have their own bus and cannot cross this boundary.
 */
export function subscribeNoticeInputs(
  bus: EventBus,
  changed: BusListener["changed"],
  failed: Listener["failed"] = () => {},
): () => void {
  const listeners = busState(bus).listeners
  const listener = { changed, failed }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Detached immutable admissions plus the number of announced, undelivered notices. */
export function noticeInputSnapshot(agent: Agent): NoticeInputSnapshot {
  const value = state(agent)
  return value.source?.() ?? value.snapshot
}

/** Synchronous after every inbox mutation, before associated legacy events or model work. */
export function subscribeNoticeInput(
  agent: Agent,
  changed: Listener["changed"],
  failed: Listener["failed"] = () => {},
): () => void {
  const listeners = state(agent).listeners
  const listener = { changed, failed }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(value: State, queue: readonly NoticeInput[], expected: number): void {
  value.snapshot = Object.freeze({ queue: Object.freeze(queue), expected })
  for (const listener of [...value.listeners]) {
    if (!value.listeners.has(listener)) continue
    try {
      listener.changed(value.snapshot)
    } catch (error) {
      // Capture cannot change whether an inbox mutation has already happened.
      try {
        listener.failed(error)
      } catch {}
    }
  }
  const agent = value.owner?.deref()
  if (!agent) return
  const listeners = busState(agent.bus).listeners
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener.changed(agent, value.snapshot)
    } catch (error) {
      try {
        listener.failed(error)
      } catch {}
    }
  }
}

/** Admission notification only; sample the inbox's owned execution records. */
export function addNoticeInput(inbox: NoticeInbox, _message: UserMessage, _expected: number): void {
  const snapshot = inbox.recoveryState()
  publish(state(inbox), snapshot.queue, snapshot.expected)
}

/** NoticeInbox drain/drop hook, including direct wake and retry promotion. */
export function clearNoticeInput(inbox: NoticeInbox, expected: number): void {
  const value = state(inbox)
  const snapshot = inbox.recoveryState()
  if (value.snapshot.queue.length || value.snapshot.expected !== expected)
    publish(value, snapshot.queue, snapshot.expected)
  const agent = value.owner?.deref()
  // Disposal unregisters session ownership before clearing its inbox. Ordinary drains keep it.
  if (agent && value.owner && !holdsAgentSession(agent)) {
    busState(agent.bus).agents.delete(value.owner)
    collected.unregister(value.owner)
  }
}

/** Expected-handle creation, cancellation, and ownership handover are observable too. */
export function expectedNoticeInput(inbox: NoticeInbox, expected: number): void {
  const value = state(inbox)
  if (value.snapshot.expected !== expected) {
    const snapshot = inbox.recoveryState()
    publish(value, snapshot.queue, snapshot.expected)
  }
}
