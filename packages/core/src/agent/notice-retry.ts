// Host-only retry lifecycle notifications. The inbox/Agent getter is the sole state authority.
import type { Agent } from "../agent.ts"
import type { EventBus } from "../event-bus.ts"
import type { NoticeInbox } from "./notices.ts"

export type NoticeRetry = NonNullable<Agent["noticeRetry"]>
type Listener = {
  changed: (agent: Agent, retry: NoticeRetry | undefined) => void
  failed: (error: unknown) => void
}
const owners = new WeakMap<NoticeInbox, WeakRef<Agent>>()
const buses = new WeakMap<EventBus, Set<Listener>>()

function listeners(bus: EventBus): Set<Listener> {
  let value = buses.get(bus)
  if (!value) {
    value = new Set()
    buses.set(bus, value)
  }
  return value
}

/** Reuse the existing inbox registration without adding an Agent capability or state copy. */
export function registerNoticeRetry(agent: Agent, inbox: NoticeInbox): void {
  owners.set(inbox, new WeakRef(agent))
}

/** Synchronous after schedule/cancel/fire mutations, before legacy events or model work.
 * Bootstrap existing owners with noticeInputAgents(bus) and each owner's noticeRetry getter.
 */
export function subscribeNoticeRetries(
  bus: EventBus,
  changed: Listener["changed"],
  failed: Listener["failed"] = () => {},
): () => void {
  const subscriptions = listeners(bus)
  const listener = { changed, failed }
  subscriptions.add(listener)
  return () => {
    subscriptions.delete(listener)
  }
}

/** Notification only: no mirrored retry snapshot can outlive cancellation or timer firing. */
export function changedNoticeRetry(inbox: NoticeInbox): void {
  const agent = owners.get(inbox)?.deref()
  if (!agent) return
  const retry = agent.noticeRetry
  if (retry) Object.freeze(retry)
  const subscriptions = listeners(agent.bus)
  for (const listener of [...subscriptions]) {
    if (!subscriptions.has(listener)) continue
    try {
      listener.changed(agent, retry)
    } catch (error) {
      try {
        listener.failed(error)
      } catch {}
    }
  }
}
