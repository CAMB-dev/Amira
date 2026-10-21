import type { EventMap, FormActionResult, FormSchema, FormValues } from "@amira/api"
import type { UiRequests } from "../ui-requests.ts"

export type FormRequest = Extract<EventMap["ui.request"], { kind: "form" }>

/** Host-issued editor identity and starting revision; both are transport data. */
export interface FormEditor {
  editor: string
  revision: number
}

/** Revisions resume monotonically when a mounted editor replaces another. */
export interface FormDraft {
  /** Omitted only by legacy callers before the backend's first editor claim. */
  editor?: string
  revision: number
  values: FormValues
}

export interface FormEvaluation {
  revision: number
  errors: Record<string, string>
  visible: Record<string, boolean>
  preview: string[]
  autoActions: string[]
  change: FormActionResult
}

export type UiResponseAck =
  | { status: "accepted" | "cancelled" | "settled" }
  | { status: "invalid" | "disconnected"; message: string }

export interface FormMutationResult {
  revision: number
  status: UiResponseAck["status"] | "stale"
  result?: FormActionResult
  message?: string
}

export interface FormOperationOptions {
  signal?: AbortSignal
  onProgress?: (text: string) => void
}

/** A host-library seam. Only these data objects, never callbacks, cross a transport. */
export interface FrontendFormBackend {
  schema: FormSchema
  /** Claim before evaluating; an aborted signal must not replace the current editor. */
  openEditor?(options?: { signal?: AbortSignal }): FormEditor | Promise<FormEditor>
  evaluate(
    draft: FormDraft & { previous?: FormValues; automaticValues?: FormValues },
  ): FormEvaluation | Promise<FormEvaluation>
  runAction(
    draft: FormDraft & { action: string; automatic?: boolean },
    options?: FormOperationOptions,
  ): Promise<FormMutationResult>
  submit(draft: FormDraft, options?: FormOperationOptions): Promise<FormMutationResult>
  cancel(editor?: string, revision?: number): UiResponseAck | Promise<UiResponseAck>
}

/** Adapters share the pending request's authority, including across transport recreation. */
export function createUiFormBackend(ui: UiRequests, request: FormRequest): FrontendFormBackend {
  const { requestId, kind: _kind, source: _source, ...schema } = request
  const authority = ui.formEditorState(requestId) ?? {
    revision: -1,
    editor: undefined,
    cachedChange: undefined,
  }
  const current = (draft: FormDraft, options: FormOperationOptions) =>
    authority.editor === draft.editor &&
    authority.revision === draft.revision &&
    !options.signal?.aborted &&
    ui.formEditorState(requestId) === authority
  const inactive = (draft: FormDraft, options: FormOperationOptions): FormMutationResult => ({
    revision: draft.revision,
    status: options.signal?.aborted
      ? "cancelled"
      : ui.requestState(requestId) === "settled"
        ? "settled"
        : "stale",
  })
  return {
    schema,
    openEditor(options = {}) {
      options.signal?.throwIfAborted()
      if (ui.formEditorState(requestId) !== authority) throw new Error("no pending form editor")
      authority.editor = crypto.randomUUID()
      authority.cachedChange = undefined
      return { editor: authority.editor, revision: ++authority.revision }
    },
    evaluate(draft) {
      if (
        ui.formEditorState(requestId) !== authority ||
        draft.editor !== authority.editor ||
        draft.revision < authority.revision
      )
        throw new Error("stale form evaluation")
      authority.revision = draft.revision
      const key = JSON.stringify([draft.values, draft.previous ?? null])
      if (authority.cachedChange?.revision !== draft.revision || authority.cachedChange.key !== key)
        authority.cachedChange = {
          revision: draft.revision,
          key,
          result: draft.previous ? ui.changeForm(requestId, draft.values, draft.previous) : {},
        }
      const change = authority.cachedChange.result
      const values = { ...draft.values, ...change.values }
      return {
        revision: draft.revision,
        change: { ...change, options: ui.formOptions(requestId) },
        errors: ui.validateForm(requestId, values) ?? {},
        visible: Object.fromEntries(
          schema.fields.map((field) => [field.id, ui.visibleForm(requestId, field.id, values)]),
        ),
        preview: ui.previewForm(requestId, values),
        autoActions: ui.autoFormActions(requestId, draft.automaticValues ?? values),
      }
    },
    async runAction(draft, options = {}) {
      if (!current(draft, options)) return inactive(draft, options)
      const result = await ui.runFormAction(requestId, draft.action, draft.values, {
        ...options,
        automatic: draft.automatic,
        accept: () => current(draft, options),
      })
      if (!current(draft, options)) return inactive(draft, options)
      return { revision: draft.revision, status: "accepted", result }
    },
    async submit(draft, options = {}) {
      if (!current(draft, options)) return inactive(draft, options)
      const result = await ui.beforeSubmitForm(requestId, draft.values, {
        ...options,
        accept: () => current(draft, options),
      })
      if (!current(draft, options)) return inactive(draft, options)
      if (result.tone === "error")
        return { revision: draft.revision, status: "invalid", result, message: result.message }
      const ack = ui.respondAcknowledged(requestId, { ...draft.values, ...result.values })
      return { revision: draft.revision, ...ack, result }
    },
    cancel: (claim, revision) =>
      // An editor may cancel a newer local draft that never reached evaluation.
      // Older revisions and replaced editors still cannot cancel the current draft.
      claim === authority.editor && (revision === undefined || revision >= authority.revision)
        ? ui.respondAcknowledged(requestId, undefined)
        : { status: "invalid", message: "stale form editor" },
  }
}
