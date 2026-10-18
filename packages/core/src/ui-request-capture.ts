import type { EventMap } from "@amira/api"
import type { EventBus } from "./event-bus.ts"
import { sessionTurnOwner } from "./session-routing.ts"
import type { UiRequests } from "./ui-requests.ts"

type RequestOwner = {
  readonly sessionId: string
  readonly turnId?: string
  readonly conversationIncarnation?: string
}
const owners = new WeakMap<UiRequests, Map<string, RequestOwner>>()

/** Internal retained DTO, available even when a request predates frontend attachment. */
export function uiRequestOwner(ui: UiRequests, requestId: string): RequestOwner | undefined {
  return owners.get(ui)?.get(requestId)
}

export function releaseUiRequestOwner(ui: UiRequests, requestId: string): void {
  owners.get(ui)?.delete(requestId)
}

type Capture = (request: EventMap["ui.request"]) => void
const captures = new WeakMap<UiRequests, Set<Capture>>()

/** Internal local lifetime seam: capture ownership before asynchronous bus delivery can lag. */
export function onUiRequestCreated(ui: UiRequests, capture: Capture): () => void {
  let listeners = captures.get(ui)
  if (!listeners) {
    listeners = new Set()
    captures.set(ui, listeners)
  }
  listeners.add(capture)
  return () => listeners.delete(capture)
}

export function captureUiRequest(ui: UiRequests, request: EventMap["ui.request"], bus: EventBus): void {
  const owner = sessionTurnOwner(request.sessionId ?? "host", bus)
  if (owner) {
    let retained = owners.get(ui)
    if (!retained) {
      retained = new Map()
      owners.set(ui, retained)
    }
    retained.set(request.requestId, Object.freeze(owner))
  }
  for (const capture of captures.get(ui) ?? []) {
    try {
      capture(request)
    } catch {
      // Frontend capture cannot prevent the host from retaining/publishing its request.
    }
  }
}
