// Host-only recovery state for input admitted behind a session hold; not an EventMap event.
import type { UserMessage } from "@amira/ai"
import type { Agent } from "../agent.ts"
import type { EventBus } from "../event-bus.ts"
import type { SessionHold } from "./hold.ts"

export interface HeldInput {
  /** Admission identity: equal messages still occupy distinct queue entries. */
  readonly id: string
  readonly holdId: string
  readonly kind: "prompt" | "steer"
  readonly message: UserMessage
  /** The admitted turn identity for a prompt; steers join that turn on promotion. */
  readonly turnId?: string
}

type Listener = {
  changed: (inputQueue: readonly HeldInput[]) => void
  failed: (error: unknown) => void
}
type Owner = Agent | SessionHold
interface State {
  snapshot: readonly HeldInput[]
  listeners: Set<Listener>
  owner?: WeakRef<Agent>
  source?: () => readonly HeldInput[]
}
type BusListener = {
  changed: (agent: Agent, queue: readonly HeldInput[]) => void
  failed: Listener["failed"]
}
const states = new WeakMap<Owner, State>()
const buses = new WeakMap<EventBus, Set<BusListener>>()
export type HoldState = { readonly id: string; readonly what: string } | null
type HoldListener = { changed: (agent: Agent, hold: HoldState) => void; failed: Listener["failed"] }
const holds = new WeakMap<EventBus, Set<HoldListener>>()

function state(owner: Owner): State {
  let value = states.get(owner)
  if (!value) {
    value = { snapshot: Object.freeze([]), listeners: new Set() }
    states.set(owner, value)
  }
  return value
}

/** Bind the private hold to its agent without adding a public Agent capability. */
export function registerHeldInput(agent: Agent, hold: SessionHold): void {
  const value = state(hold)
  value.owner = new WeakRef(agent)
  value.source = () => hold.recoveryState()
  states.set(agent, value)
}

/** Detached, immutable admission records, in queue order. No subscription side effects. */
export function heldInputSnapshot(agent: Agent): readonly HeldInput[] {
  const value = state(agent)
  return value.source?.() ?? value.snapshot
}

/** Runs synchronously after each queue mutation, before related legacy events are emitted. */
export function subscribeHeldInput(
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

/** Runtime-wide held-input changes, including visible children and replacement roots. */
export function subscribeHeldInputs(
  bus: EventBus,
  changed: BusListener["changed"],
  failed: Listener["failed"] = () => {},
): () => void {
  let listeners = buses.get(bus)
  if (!listeners) {
    listeners = new Set()
    buses.set(bus, listeners)
  }
  const listener = { changed, failed }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function holdStateSnapshot(agent: Agent): HoldState {
  const id = agent.holdId
  return id ? Object.freeze({ id, what: agent.holdingFor ?? "session" }) : null
}

export function subscribeHolds(
  bus: EventBus,
  changed: HoldListener["changed"],
  failed: Listener["failed"] = () => {},
): () => void {
  let listeners = holds.get(bus)
  if (!listeners) {
    listeners = new Set()
    holds.set(bus, listeners)
  }
  const listener = { changed, failed }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Notify hold acquisition/release even when no input was queued. */
export function publishHoldState(hold: SessionHold): void {
  const owner = state(hold).owner?.deref()
  if (!owner) return
  const listeners = holds.get(owner.bus)
  for (const listener of [...(listeners ?? [])]) {
    if (!listeners?.has(listener)) continue
    try {
      listener.changed(owner, holdStateSnapshot(owner))
    } catch (error) {
      try {
        listener.failed(error)
      } catch {}
    }
  }
}

function publish(value: State, snapshot: readonly HeldInput[]): void {
  value.snapshot = Object.freeze(snapshot)
  for (const listener of [...value.listeners]) {
    if (!value.listeners.has(listener)) continue
    try {
      listener.changed(value.snapshot)
    } catch (error) {
      // Capture failures must not turn an already-admitted prompt into an apparent rejection.
      try {
        listener.failed(error)
      } catch {}
    }
  }
  const owner = value.owner?.deref()
  if (!owner) return
  const listeners = buses.get(owner.bus)
  for (const listener of [...(listeners ?? [])]) {
    if (!listeners?.has(listener)) continue
    try {
      listener.changed(owner, value.snapshot)
    } catch (error) {
      try {
        listener.failed(error)
      } catch {}
    }
  }
}

/** Admission notification only; sample the hold's owned execution records. */
export function addHeldInput(hold: SessionHold, _input: Omit<HeldInput, "id">): void {
  publish(state(hold), hold.recoveryState())
}

/** SessionHold's drain/drop hook, before promotion, turn start, or dropped-input events. */
export function clearHeldInput(hold: SessionHold): void {
  const value = state(hold)
  if (value.snapshot.length) publish(value, hold.recoveryState())
}
