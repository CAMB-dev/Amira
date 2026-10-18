import type { FormValues } from "@amira/api"
import {
  createUiFormBackend,
  type FormDraft,
  type FormEditor,
  type FormEvaluation,
  type FormMutationResult,
  type FrontendJson,
  FrontendOperationError,
  type UiResponseAck,
} from "@amira/core"
import type { Session } from "../session-factory.ts"

/** Revisioned data operations only; form validators/actions remain in the workspace host. */
export interface ServerUiOperations {
  "ui.respond": { params: { requestId: string; value: FrontendJson }; result: UiResponseAck }
  "ui.cancel": { params: { requestId: string }; result: UiResponseAck }
  "form.open": { params: { requestId: string }; result: FormEditor }
  "form.evaluate": {
    params: { requestId: string; draft: FormDraft & { previous?: FormValues; automaticValues?: FormValues } }
    result: FormEvaluation
  }
  "form.action": {
    params: { requestId: string; draft: FormDraft & { action: string; automatic?: boolean } }
    result: FormMutationResult
  }
  "form.submit": { params: { requestId: string; draft: FormDraft }; result: FormMutationResult }
  "form.cancel": {
    params: { requestId: string; editor?: string; revision?: number }
    result: UiResponseAck
  }
}

export function createServerUiOperations(ui: Session["host"]["ui"]) {
  const form = (requestId: string) => {
    const request = ui.pending.find((pending) => pending.requestId === requestId)
    if (request?.kind !== "form")
      throw new FrontendOperationError("stale_operation", "The form is no longer pending")
    return createUiFormBackend(ui, request)
  }
  const respond = (requestId: string, value: FrontendJson) => {
    if (ui.pending.some((request) => request.requestId === requestId && request.kind === "form"))
      return { status: "invalid", message: "Use the revisioned form submit or cancel operation" } as const
    return ui.respondAcknowledged(requestId, value)
  }
  return {
    "ui.respond": ({ requestId, value }: ServerUiOperations["ui.respond"]["params"]) =>
      respond(requestId, value),
    "ui.cancel": ({ requestId }: ServerUiOperations["ui.cancel"]["params"]) => respond(requestId, null),
    "form.open": ({ requestId }: ServerUiOperations["form.open"]["params"], signal?: AbortSignal) =>
      form(requestId).openEditor!({ signal }),
    "form.evaluate": ({ requestId, draft }: ServerUiOperations["form.evaluate"]["params"]) =>
      form(requestId).evaluate(draft),
    "form.action": (
      { requestId, draft }: ServerUiOperations["form.action"]["params"],
      signal?: AbortSignal,
    ) =>
      ui.requestState(requestId) === "settled"
        ? ({ revision: draft.revision, status: "settled" } as const)
        : form(requestId).runAction(draft, { signal }),
    "form.submit": (
      { requestId, draft }: ServerUiOperations["form.submit"]["params"],
      signal?: AbortSignal,
    ) =>
      ui.requestState(requestId) === "settled"
        ? ({ revision: draft.revision, status: "settled" } as const)
        : form(requestId).submit(draft, { signal }),
    "form.cancel": ({ requestId, editor, revision }: ServerUiOperations["form.cancel"]["params"]) =>
      ui.requestState(requestId) === "settled"
        ? ({ status: "settled" } as const)
        : form(requestId).cancel(editor, revision),
  }
}
