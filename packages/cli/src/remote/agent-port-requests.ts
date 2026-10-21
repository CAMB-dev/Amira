import { type OverlayRequestBackend, operationFormBackend } from "@amira/tui"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import type { RemoteAgentPort } from "./agent-port.ts"
import { createRemoteFormBackend } from "./agent-port-forms.ts"

/** Mount once per frontend; resets reconcile pending state without replaying dialog effects. */
export function createRemoteOverlayBackend(
  port: RemoteAgentPort,
): OverlayRequestBackend & { dispose(): void } {
  const known = new Set<string>()
  const remember = (id: string) => {
    known.add(id)
    if (known.size > 4096) known.delete(known.values().next().value!)
  }
  const reconcile = () => {
    for (const request of port.pendingRequests) remember(request.requestId)
  }
  reconcile()
  const offs = [
    port.subscribeReset(reconcile),
    port.subscribeEvents((event) => {
      if (event.type === "ui.request" || event.type === "ui.resolved") remember(event.data.requestId)
    }),
  ]
  return {
    requestState: (id) =>
      port.pendingRequests.some((request) => request.requestId === id)
        ? "pending"
        : known.has(id)
          ? "settled"
          : "unknown",
    respond: async (requestId, value) =>
      value === undefined
        ? port.request("ui.cancel", { requestId })
        : port.request("ui.respond", { requestId, value: frontendJson(value) }),
    form: (request) => operationFormBackend(createRemoteFormBackend(port, request)),
    settings: (request) => ({
      request,
      submit: (values, scope) =>
        port.request("ui.respond", { requestId: request.requestId, value: { values, scope } }),
      cancel: () => port.request("ui.cancel", { requestId: request.requestId }),
    }),
    dispose() {
      for (const off of offs) off()
      known.clear()
    },
  }
}
