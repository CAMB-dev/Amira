import {
  type AskQuestion,
  autoFormActions,
  checkForm,
  describeFormErrors,
  type EventMap,
  type ExtensionSettingField,
  type ExtensionSettingsPreviewContext,
  type ExtensionSettingsScope,
  type ExtensionSettingsValues,
  type FormActionResult,
  type FormOption,
  type FormSpec,
  type FormValues,
  formDefaults,
  isFieldVisible,
  type MarkdownRenderResult,
  runFormAction,
  runFormBeforeSubmit,
  runFormChange,
  runFormDialogs,
  type SelectChoice,
  type SelectSection,
  type SettingsLayer,
  sectionOf,
  toFormSchema,
  type UiAnswer,
  type UiApi,
  type UiRequest,
  type UiRequestOptions,
  validateExtensionSetting,
} from "@amira/api"
import { checkAskAnswers } from "./ask-answers.ts"
import type { EventBus } from "./event-bus.ts"
import type { UiResponseAck } from "./frontend/form-backend.ts"
import { captureUiRequest, releaseUiRequestOwner } from "./ui-request-capture.ts"

type Value = UiAnswer[keyof UiAnswer]
type SelectLive = NonNullable<Parameters<UiApi["choose"]>[2]["live"]>

/** Only display data leaves the host; option strings remain the answer identities. */
function selectPresentation(live: SelectLive) {
  const { optionLabels, optionStatuses, descriptions } = live()
  return {
    ...(optionLabels ? { optionLabels: [...optionLabels] } : {}),
    ...(optionStatuses ? { optionStatuses: [...optionStatuses] } : {}),
    ...(descriptions ? { descriptions: [...descriptions] } : {}),
  }
}

/** Host-only settings callbacks. Drafts never replace the extension's effective settings. */
export interface ExtensionSettingsBackend {
  /** Canonical host identity, even when the page was opened through a display alias. */
  name?: string
  title?: string
  sources?: Readonly<Record<string, readonly SettingsLayer[]>>
  fields: readonly ExtensionSettingField[]
  get(): ExtensionSettingsValues
  defaultScope: ExtensionSettingsScope
  preview?(
    draft: ExtensionSettingsValues,
    context: ExtensionSettingsPreviewContext,
  ): MarkdownRenderResult | Promise<MarkdownRenderResult>
  save(values: ExtensionSettingsValues, scope: "user" | "project"): void | Promise<void>
}

interface Pending {
  request: EventMap["ui.request"]
  resolve: (value: Value | undefined) => void
  cleanup: () => void
  /** For a form: the spec with its validators and actions, which never leave the host. */
  form?: FormState
  settings?: ExtensionSettingsBackend
  settingsEditor?: object
  saving?: boolean
}

interface AutomaticFormAttempt {
  key: string
  running?: { controller: AbortController; accept?: () => boolean }
}

interface FormEditorState {
  revision: number
  editor?: string
  cachedChange?: { revision: number; key: string; result: FormActionResult }
}

interface FormState {
  spec: FormSpec
  /** Editor authority lives only as long as the pending request, across adapter recreation. */
  authority: FormEditorState
  /** Private in-memory approval; never persisted or emitted. */
  approved?: { editor?: string; revision: number; values: string }
  checking?: boolean
  /** Filtered updates from a refused direct submission; no secret values. */
  recovery?: FormValues
  /** Options actions have filled in since the form was asked, by field id. */
  options: Record<string, FormOption[]>
  /** Actions running now; aborted when the form closes. */
  running: Set<AbortController>
  /** Completed attempts survive replacement; obsolete running attempts may be retried. */
  automatic: Map<string, AutomaticFormAttempt>
}

/**
 * How forms are shown: `native` sends them as one ui.request of kind "form" (the TUI and rpc
 * clients show them whole); `dialogs` asks them one field at a time (runFormDialogs), for
 * clients that only know select, confirm and input.
 */
export type FormMode = "native" | "dialogs"

/**
 * Dialogs waiting for the user (D42). Asking emits ui.request; whichever frontend is attached
 * answers with respond() or cancel(), and ui.resolved tells every frontend it is closed.
 * Forms keep their validators and actions here: frontends reach them with validateForm()
 * and runFormAction().
 */
export class UiRequests {
  #bus: EventBus
  #sessionId: string
  #pending = new Map<string, Pending>()
  #dialogForms = new Map<AbortController, string | undefined>()
  // Keep only IDs, for this service's lifetime: delayed/cloned events must stay settled.
  #settled = new Set<string>()
  #sourceLabels = new Map<string, string>()
  #seq = 0
  #settings: ((name: string) => ExtensionSettingsBackend | undefined) | undefined
  formMode: FormMode = "native"
  /** Whether the frontend can call live form callbacks; otherwise those forms use dialogs. */
  nativeFormCallbacks = true
  /**
   * Why no frontend can answer (e.g. "print mode"), set by a frontend that cancels every
   * dialog. Askers that can say so without asking (ask_user) read it; dialogs are still sent.
   */
  unavailable: string | undefined

  constructor(bus: EventBus, opts: { sessionId?: string } = {}) {
    this.#bus = bus
    this.#sessionId = opts.sessionId ?? "host"
  }

  /** A display name for an extension; its source remains the cancellation identity. */
  setSourceLabel(source: string, label: string | undefined): void {
    if (label === undefined) this.#sourceLabels.delete(source)
    else this.#sourceLabels.set(source, label)
  }

  /** Binds the host registry; functions and preview images do not cross the event boundary. */
  setExtensionSettingsAccessor(accessor: (name: string) => ExtensionSettingsBackend | undefined): void {
    this.#settings = accessor
  }

  /** A pending settings page's callbacks; undefined once resolved or for another request kind. */
  extensionSettingsBackend(requestId: string): ExtensionSettingsBackend | undefined {
    return this.#pending.get(requestId)?.settings
  }

  /** Local settings adapters share request-lifetime editor authority, just like forms. */
  claimExtensionSettingsEditor(requestId: string): () => boolean {
    const pending = this.#pending.get(requestId)
    if (!pending?.settings) return () => false
    const editor = {}
    pending.settingsEditor = editor
    return () => this.#pending.get(requestId) === pending && pending.settingsEditor === editor
  }

  extensionSettings(
    name: string,
    opts: UiRequestOptions & { source?: string } = {},
  ): Promise<UiAnswer["extension-settings"] | undefined> {
    if (opts.signal?.aborted) return Promise.resolve(undefined)
    const settings = this.#settings?.(name)
    if (!settings) throw new Error(`there are no settings for extension "${name}"`)
    return this.#ask(
      {
        kind: "extension-settings",
        name: settings.name ?? name,
        title: settings.title ?? name,
        fields: structuredClone([...settings.fields]),
        values: structuredClone(settings.get()),
        sources: Object.fromEntries(
          Object.entries(settings.sources ?? {}).flatMap(([key, layers]) => {
            const scope = layers.at(-1)?.scope
            return scope ? [[key, scope]] : []
          }),
        ),
        scope: settings.defaultScope === "user" ? "user" : "project",
      },
      opts,
      undefined,
      settings,
    ) as Promise<UiAnswer["extension-settings"] | undefined>
  }

  /** Dialogs still waiting, oldest first. */
  get pending(): EventMap["ui.request"][] {
    return [...this.#pending.values()].map((p) => p.request)
  }

  /**
   * Registered request lifecycle, even before its queued event reaches a frontend.
   * Unknown IDs may be requests announced externally, without this service as their owner.
   */
  requestState(requestId: string): "pending" | "settled" | "unknown" {
    if (this.#pending.has(requestId)) return "pending"
    return this.#settled.has(requestId) ? "settled" : "unknown"
  }

  /** Resolves with the answer, or undefined when cancelled, aborted or timed out. */
  ask<K extends Exclude<keyof UiAnswer, "form" | "extension-settings">>(
    request: Extract<UiRequest, { kind: K }>,
    opts: UiRequestOptions & { source?: string } = {},
  ): Promise<UiAnswer[K] | undefined> {
    return this.#ask(request, opts) as Promise<UiAnswer[K] | undefined>
  }

  /** Asks a form: natively, or one field at a time in `dialogs` mode. */
  form(spec: FormSpec, opts: UiRequestOptions & { source?: string } = {}): Promise<FormValues | undefined> {
    if (
      this.formMode === "dialogs" ||
      (!this.nativeFormCallbacks && (spec.change || spec.visible || spec.preview))
    ) {
      const api = this.api(opts.source)
      const upstream = timeoutSignal(opts)
      const controller = new AbortController()
      const onAbort = () => controller.abort(upstream?.reason)
      if (upstream?.aborted) onAbort()
      else upstream?.addEventListener("abort", onAbort, { once: true })
      this.#dialogForms.set(controller, opts.source)
      const operation = runFormDialogs(
        spec,
        {
          select: (title, options, dialogOpts) =>
            api.select(title, options, { ...dialogOpts, sessionId: opts.sessionId }),
          input: (title, dialogOpts) => api.input(title, { ...dialogOpts, sessionId: opts.sessionId }),
        },
        { signal: controller.signal },
      )
      const cancelled = new Promise<undefined>((resolve) => {
        if (controller.signal.aborted) resolve(undefined)
        else controller.signal.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      return Promise.race([operation, cancelled]).finally(() => {
        this.#dialogForms.delete(controller)
        upstream?.removeEventListener("abort", onAbort)
        controller.abort()
      })
    }
    const form: FormState = {
      spec,
      authority: { revision: -1 },
      options: {},
      running: new Set(),
      automatic: new Map(),
    }
    return this.#ask({ kind: "form", ...toFormSchema(spec) }, opts, form) as Promise<FormValues | undefined>
  }

  #ask(
    request: UiRequest,
    opts: UiRequestOptions & { source?: string },
    form?: FormState,
    settings?: ExtensionSettingsBackend,
    live?: SelectLive,
  ) {
    if (opts.signal?.aborted) return Promise.resolve(undefined)
    const requestId = `ui_${++this.#seq}_${crypto.randomUUID().slice(0, 6)}`
    const sessionId = opts.sessionId ?? this.#sessionId
    const sourceLabel = opts.source ? this.#sourceLabels.get(opts.source) : undefined
    const presentation = live ? selectPresentation(live) : undefined
    const event = {
      ...request,
      ...presentation,
      requestId,
      sessionId,
      ...(opts.source ? { source: opts.source } : {}),
      ...(sourceLabel !== undefined ? { sourceLabel } : {}),
    } as EventMap["ui.request"]
    return new Promise<Value | undefined>((resolve) => {
      const onAbort = () => this.cancel(requestId)
      const timer = opts.timeoutMs !== undefined ? setTimeout(onAbort, opts.timeoutMs) : undefined
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      let unsubscribe: (() => void) | undefined
      this.#pending.set(requestId, {
        request: event,
        resolve,
        cleanup: () => {
          clearTimeout(timer)
          unsubscribe?.()
          opts.signal?.removeEventListener("abort", onAbort)
          for (const c of form?.running ?? []) c.abort()
        },
        ...(form ? { form } : {}),
        ...(settings ? { settings } : {}),
      })
      if (live && event.kind === "select") {
        let previous = JSON.stringify(presentation)
        unsubscribe = this.#bus.subscribe((e) => {
          // Presentation updates must not feed back into themselves or reopen closed choices.
          if (e.type.startsWith("ui.")) return
          const pending = this.#pending.get(requestId)
          if (!pending) return
          const next = selectPresentation(live)
          const serialized = JSON.stringify(next)
          if (serialized === previous) return
          previous = serialized
          pending.request = {
            ...event,
            optionLabels: next.optionLabels,
            optionStatuses: next.optionStatuses,
            descriptions: next.descriptions,
          }
          this.#bus.emit("ui.request", pending.request, { sessionId })
        })
      }
      captureUiRequest(this, event, this.#bus)
      this.#bus.emit("ui.request", event, { sessionId })
    })
  }

  /**
   * Answers a dialog. null or undefined cancels it. Returns an error message when the
   * request is unknown or the value does not fit its kind (for a form: a field is invalid);
   * the dialog then stays open.
   */
  respond(requestId: string, value: unknown): string | undefined {
    const p = this.#pending.get(requestId)
    if (!p) return `no pending ui request "${requestId}"`
    if (value === null || value === undefined) {
      this.cancel(requestId)
      return undefined
    }
    if (p.form) {
      if (typeof value !== "object" || Array.isArray(value)) return "value must be an object of field values"
      const { values, errors } = checkForm(
        p.form.spec,
        { ...p.form.recovery, ...(value as Record<string, unknown>) },
        p.form.options,
      )
      if (Object.keys(errors).length) return `invalid form values: ${describeFormErrors(p.form.spec, errors)}`
      if (p.form.spec.beforeSubmit && !formApproved(p.form, values)) {
        if (p.form.checking) return "form is being checked"
        p.form.checking = true
        const { editor, revision } = p.form.authority
        void this.beforeSubmitForm(requestId, values).then((result) => {
          if (this.#pending.get(requestId) !== p) return
          p.form!.checking = false
          if (p.form!.authority.editor !== editor || p.form!.authority.revision !== revision) return
          const final = checkForm(p.form!.spec, { ...values, ...result.values }, p.form!.options)
          if (result.tone === "error" || Object.keys(final.errors).length) {
            p.form!.approved = undefined
            p.form!.recovery = { ...p.form!.recovery, ...result.values }
            this.#bus.emit(
              "ui.progress",
              {
                requestId,
                action: "save",
                text: result.message ?? describeFormErrors(p.form!.spec, final.errors),
                form: { result, errors: final.errors },
              },
              { sessionId: p.request.sessionId ?? this.#sessionId },
            )
            return
          }
          this.#settle(requestId, final.values)
        })
        return undefined
      }
      this.#settle(requestId, values)
      return undefined
    }
    const problem = checkValue(p.request, value)
    if (problem) return problem
    if (p.settings) {
      if (p.saving) return "settings are being saved"
      // RPC responders keep their synchronous contract. Native pages await this operation below.
      const editor = p.settingsEditor
      void this.submitExtensionSettings(requestId, value as UiAnswer["extension-settings"]).then((error) => {
        if (error && this.#pending.get(requestId) === p && p.settingsEditor === editor)
          this.#bus.emit(
            "ui.progress",
            { requestId, action: "save", text: error },
            { sessionId: p.request.sessionId ?? this.#sessionId },
          )
      })
      return undefined
    }
    this.#settle(requestId, value as Value)
    return undefined
  }

  /** Acknowledged responses never treat transport loss as cancellation. Legacy respond stays synchronous. */
  respondAcknowledged(requestId: string, value: unknown): UiResponseAck {
    if (this.requestState(requestId) === "settled") return { status: "settled" }
    const pending = this.#pending.get(requestId)
    if (value !== null && value !== undefined) {
      // Only the revisioned submit operation may start an asynchronous save/check. An invalid
      // acknowledgement must not secretly schedule a legacy submission that later settles.
      if (pending?.settings) return { status: "invalid", message: "use the settings submit operation" }
      const form = pending?.form
      if (form?.spec.beforeSubmit && typeof value === "object" && !Array.isArray(value)) {
        const checked = checkForm(form.spec, { ...form.recovery, ...value }, form.options)
        if (!formApproved(form, checked.values))
          return { status: "invalid", message: "form must be checked before submission" }
      }
    }
    const problem = this.respond(requestId, value)
    if (problem) return { status: "invalid", message: problem }
    if (value === null || value === undefined) return { status: "cancelled" }
    // Async legacy form/settings submissions are not yet acknowledged resolutions.
    if (this.requestState(requestId) !== "settled")
      return { status: "invalid", message: "request is being checked" }
    return { status: "accepted" }
  }

  /** Saves a settings draft, resolving the request only after the host accepts and persists it. */
  async submitExtensionSettings(
    requestId: string,
    answer: UiAnswer["extension-settings"],
  ): Promise<string | undefined> {
    const pending = this.#pending.get(requestId)
    if (!pending?.settings) return `no pending extension settings "${requestId}"`
    const problem = checkValue(pending.request, answer)
    if (problem) return problem
    if (pending.saving) return "settings are being saved"
    pending.saving = true
    const values = structuredClone(answer.values)
    const scope = answer.scope
    const editor = pending.settingsEditor
    try {
      await pending.settings.save(values, scope)
      // Persistence already admitted cannot be undone, but its abandoned editor cannot close a replacement.
      if (this.#pending.get(requestId) !== pending || pending.settingsEditor !== editor)
        return "stale settings editor"
      this.#settle(requestId, { values, scope })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      pending.saving = false
    }
    return undefined
  }

  /**
   * Checks a pending form's values as they stand, validators included: problems by field id
   * (empty when it may be submitted); undefined for an unknown request or one that is no form.
   */
  validateForm(requestId: string, values: Record<string, unknown>): Record<string, string> | undefined {
    const form = this.#pending.get(requestId)?.form
    if (!form) return undefined
    return checkForm(form.spec, values, form.options).errors
  }

  /** Runs live updates; only filtered display values/options leave the host. */
  changeForm(requestId: string, values: FormValues, previous: FormValues): FormActionResult {
    const form = this.#pending.get(requestId)?.form
    if (!form) return {}
    // Hidden defaults remain part of the draft: revealing them is not a user edit.
    const result = runFormChange(form.spec, structuredClone(values), structuredClone(previous))
    if (result.options) Object.assign(form.options, result.options)
    return result
  }

  /** Only computed preview lines cross the backend boundary, never the callback. */
  previewForm(requestId: string, values: FormValues): string[] {
    const form = this.#pending.get(requestId)?.form
    return form?.spec.preview?.(checkForm(toFormSchema(form.spec), values, form.options).values) ?? []
  }

  /** Final asynchronous check; tied to request cancellation like ordinary actions. */
  async beforeSubmitForm(
    requestId: string,
    values: FormValues,
    opts: {
      signal?: AbortSignal
      onProgress?: (text: string) => void
      accept?: () => boolean
      automatic?: boolean
    } = {},
  ): Promise<FormActionResult> {
    const form = this.#pending.get(requestId)?.form
    if (!form) return { message: `no pending form "${requestId}"`, tone: "error" }
    const { editor, revision } = form.authority
    const current = () =>
      this.#pending.get(requestId)?.form === form &&
      form.authority.editor === editor &&
      form.authority.revision === revision &&
      (opts.accept?.() ?? true)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    if (opts.signal?.aborted) controller.abort()
    form.running.add(controller)
    try {
      const result = await runFormBeforeSubmit(form.spec, checkForm(form.spec, values, form.options).values, {
        signal: controller.signal,
        progress: (text) => {
          if (!controller.signal.aborted && current()) opts.onProgress?.(text)
        },
      })
      if (!controller.signal.aborted && current()) {
        if (result.options) Object.assign(form.options, result.options)
        if (result.tone !== "error")
          form.approved = {
            editor,
            revision,
            values: JSON.stringify(
              checkForm(form.spec, { ...values, ...result.values }, form.options).values,
            ),
          }
      }
      return result
    } finally {
      form.running.delete(controller)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  }

  /** Shared host editor state; deleting the pending request releases its authority and cache. */
  formEditorState(requestId: string): FormEditorState | undefined {
    return this.#pending.get(requestId)?.form?.authority
  }

  /** Retained display options let a newly mounted editor recover completed action output. */
  formOptions(requestId: string): Record<string, FormOption[]> {
    return structuredClone(this.#pending.get(requestId)?.form?.options ?? {})
  }

  /** Computes conditional presentation without sending host callbacks to a frontend. */
  visibleForm(requestId: string, fieldId: string, values: FormValues): boolean {
    const form = this.#pending.get(requestId)?.form
    const field = form?.spec.fields.find((field) => field.id === fieldId)
    return !!(form && field && isFieldVisible(form.spec, field, { ...formDefaults(form.spec), ...values }))
  }

  /** Eligible automatic actions of a pending form; readiness callbacks stay with the host. */
  autoFormActions(requestId: string, values: Record<string, unknown>): string[] {
    const form = this.#pending.get(requestId)?.form
    if (!form) return []
    return autoFormActions(form.spec, values, form.options)
  }

  /**
   * Runs an action of a pending form with the values so far. Progress goes out as ui.progress
   * (and to `onProgress`); the result never carries secret values. Aborted by `signal` and
   * when the form closes.
   */
  async runFormAction(
    requestId: string,
    action: string,
    values: Record<string, unknown>,
    opts: {
      signal?: AbortSignal
      onProgress?: (text: string) => void
      accept?: () => boolean
      automatic?: boolean
    } = {},
  ): Promise<FormActionResult> {
    const pending = this.#pending.get(requestId)
    if (!pending?.form) return { message: `no pending form "${requestId}"`, tone: "error" }
    const form = pending.form
    const { editor, revision } = form.authority
    const accept = () =>
      this.#pending.get(requestId) === pending &&
      form.authority.editor === editor &&
      form.authority.revision === revision &&
      (opts.accept?.() ?? true)
    const field = form.spec.fields.find((field) => field.id === action)
    // Field checks do not matter here; an action may run on a half-filled form.
    const current = checkForm(form.spec, values, form.options).values
    // Fingerprints stay host-local; only completed or still-current attempts suppress admission.
    const automaticKey =
      opts.automatic && field?.type === "action" && field.auto
        ? JSON.stringify([
            action,
            field.auto.watch.map((dependency) => {
              const name = typeof dependency === "string" ? dependency : dependency.field
              const applies =
                typeof dependency === "string" ||
                Object.entries(dependency.when).every(([id, value]) => current[id] === value)
              const watched = form.spec.fields.find((field) => field.id === name)
              return applies && watched && isFieldVisible(form.spec, watched, current)
                ? current[name]
                : undefined
            }),
          ])
        : undefined
    if (automaticKey !== undefined) {
      const previous = form.automatic.get(action)?.running
      if (previous && (previous.controller.signal.aborted || !(previous.accept?.() ?? true))) {
        previous.controller.abort()
        form.automatic.delete(action)
      }
      if (
        form.automatic.get(action)?.key === automaticKey ||
        !this.autoFormActions(requestId, values).includes(action)
      )
        return {}
    }
    const controller = new AbortController()
    const attempt: AutomaticFormAttempt | undefined =
      automaticKey === undefined ? undefined : { key: automaticKey, running: { controller, accept } }
    // Record a unique attempt before extension code; an old finally cannot erase its replacement.
    if (attempt) form.automatic.set(action, attempt)
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    if (opts.signal?.aborted) controller.abort()
    form.running.add(controller)
    try {
      const result = await runFormAction(form.spec, action, current, {
        signal: controller.signal,
        progress: (text) => {
          if (controller.signal.aborted || !accept()) return
          opts.onProgress?.(text)
          this.#bus.emit(
            "ui.progress",
            { requestId, action, text },
            { sessionId: pending.request.sessionId ?? this.#sessionId },
          )
        },
      })
      if (!controller.signal.aborted && accept() && result.options)
        Object.assign(form.options, result.options)
      return result
    } finally {
      if (attempt && form.automatic.get(action) === attempt) {
        if (controller.signal.aborted || !accept()) form.automatic.delete(action)
        else attempt.running = undefined
      }
      form.running.delete(controller)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  }

  cancel(requestId: string): boolean {
    if (!this.#pending.has(requestId)) return false
    this.#settle(requestId, undefined)
    return true
  }

  /** Cancels pages whose settings owner unloaded, even when another extension opened them. */
  cancelExtensionSettings(name: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.request.kind === "extension-settings" && pending.request.name === name) this.cancel(id)
    }
  }

  /** Cancels every dialog, or only those asked by one extension. */
  cancelAll(source?: string): void {
    for (const [controller, owner] of this.#dialogForms)
      if (source === undefined || owner === source) controller.abort()
    for (const [id, p] of this.#pending)
      if (source === undefined || p.request.source === source) this.cancel(id)
  }

  /** The dialog methods handed to an extension. */
  api(source?: string): UiApi {
    const o = (opts?: UiRequestOptions) => ({ ...opts, ...(source ? { source } : {}) })
    return {
      select: async (title, options, opts = {}) => {
        const { initial, ...rest } = opts
        const answer = await this.ask(
          {
            kind: "select",
            title,
            options: [...options],
            ...(initial !== undefined ? { initial } : {}),
          },
          o(rest),
        )
        return typeof answer === "object" ? answer.option : answer
      },
      choose: async (title, options, opts) => {
        const { sections, descriptions, searchTexts, optionStatuses, live, initial, ...rest } = opts
        const problem = sectionProblem(options, sections)
        if (problem) throw new Error(`ui.choose: ${problem}`)
        const request = {
          kind: "select" as const,
          title,
          options: [...options],
          sections: structuredClone(sections),
          ...(initial !== undefined ? { initial } : {}),
          ...(descriptions ? { descriptions: [...descriptions] } : {}),
          ...(searchTexts ? { searchTexts: [...searchTexts] } : {}),
          ...(optionStatuses ? { optionStatuses: [...optionStatuses] } : {}),
        }
        const answer = (await this.#ask(request, o(rest), undefined, undefined, live)) as
          | UiAnswer["select"]
          | undefined
        return typeof answer === "string" ? { option: answer } : answer
      },
      confirm: async (title, message, opts) => {
        const request = { kind: "confirm" as const, title, ...(message !== undefined ? { message } : {}) }
        const answer = await this.ask(request, o(opts))
        return answer === undefined ? undefined : answer === true || answer === "always"
      },
      input: (title, opts = {}) => {
        const { placeholder, initial, secret, ...rest } = opts
        return this.ask(
          {
            kind: "input",
            title,
            ...(placeholder !== undefined ? { placeholder } : {}),
            // A secret input never carries a value to frontends.
            ...(initial !== undefined && !secret ? { initial } : {}),
            ...(secret ? { secret: true } : {}),
          },
          o(rest),
        )
      },
      reviewDiff: (title, diff, options, opts) =>
        this.ask({ kind: "diff-review", title, diff, options: [...options] }, o(opts)),
      ask: (questions, opts = {}) => {
        const { title, ...rest } = opts
        const request = {
          kind: "ask" as const,
          title: title ?? askTitle(questions),
          questions: structuredClone(questions),
        }
        return this.ask(request, o(rest))
      },
      form: (spec, opts) => this.form(spec, o(opts)),
      extensionSettings: (name, opts) => this.extensionSettings(name, o(opts)),
    }
  }

  #settle(requestId: string, value: Value | undefined) {
    const p = this.#pending.get(requestId)!
    this.#pending.delete(requestId)
    releaseUiRequestOwner(this, requestId)
    this.#settled.add(requestId)
    p.cleanup()
    // Form values and secret answers stay out of events, which frontends and extensions log.
    const r = p.request
    const shareable =
      value !== undefined &&
      r.kind !== "form" &&
      !(r.kind === "input" && r.secret) &&
      typeof value !== "object"
    this.#bus.emit(
      "ui.resolved",
      {
        requestId,
        cancelled: value === undefined,
        ...(shareable ? { value: value as string | boolean } : {}),
      },
      { sessionId: r.sessionId ?? this.#sessionId },
    )
    p.resolve(value)
  }
}

function formApproved(form: FormState, values: FormValues): boolean {
  return (
    form.approved?.editor === form.authority.editor &&
    form.approved?.revision === form.authority.revision &&
    form.approved?.values === JSON.stringify(values)
  )
}

/** The caller's signal, joined with a timeout when one is given. */
function timeoutSignal(opts: UiRequestOptions): AbortSignal | undefined {
  const signals = [
    opts.signal,
    opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  ]
  const present = signals.filter((s): s is AbortSignal => s !== undefined)
  if (present.length <= 1) return present[0]
  return AbortSignal.any(present)
}

function checkValue(request: UiRequest, value: unknown): string | undefined {
  switch (request.kind) {
    case "select":
      if (isSelectChoice(value) && request.options.includes(value.option)) {
        if (value.key === undefined) return undefined
        const keys = sectionOf(request.sections, request.options.indexOf(value.option))?.keys ?? []
        return keys.some((k) => k.key === value.key)
          ? undefined
          : `key must be one of the keys of the option's section: ${JSON.stringify(keys.map((k) => k.key))}`
      }
      return typeof value === "string" && request.options.includes(value)
        ? undefined
        : `value must be one of the options: ${JSON.stringify(request.options)}${request.sections ? ', or {"option": option, "key": key}' : ""}`
    case "diff-review":
      return typeof value === "string" && request.options.includes(value)
        ? undefined
        : `value must be one of the options: ${JSON.stringify(request.options)}`
    case "confirm":
      if (typeof value === "boolean") return undefined
      if (value === "always" && request.always) return undefined
      if (request.other && isOther(value)) return undefined
      return `value must be true or false${request.always ? ', or "always"' : ""}${request.other ? ', or {"other": text}' : ""}`
    case "ask":
      return checkAskAnswers(request.questions, value)
    case "input":
      return typeof value === "string" ? undefined : "value must be a string"
    case "form":
      return "value must be an object of field values"
    case "extension-settings": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return "value must contain settings values and scope"
      const answer = value as Partial<UiAnswer["extension-settings"]>
      if (answer.scope !== "user" && answer.scope !== "project") return "scope must be user or project"
      if (typeof answer.values !== "object" || answer.values === null || Array.isArray(answer.values))
        return "values must be an object of settings values"
      const values = answer.values
      for (const key of Object.keys(values))
        if (!request.fields.some((field) => field.key === key)) return `unknown setting "${key}"`
      for (const field of request.fields) {
        const problem = validateExtensionSetting(
          field,
          Object.hasOwn(values, field.key) ? values[field.key] : undefined,
        )
        if (problem) return `${field.label}: ${problem}`
      }
      return undefined
    }
  }
}

/**
 * What is wrong with a select's sections, if anything. Options are told apart by their label,
 * so they must differ; sections go in order within the list; a key is one printable character
 * that is not a digit (digits pick options) and is not used twice in a section.
 */
function sectionProblem(options: readonly string[], sections: readonly SelectSection[]): string | undefined {
  if (new Set(options).size !== options.length) return "options must differ"
  let last = -1
  for (const s of sections) {
    if (!Number.isInteger(s.at) || s.at <= last || s.at >= options.length)
      return `section at ${s.at}: sections start at increasing option indexes within the list`
    last = s.at
    const keys = s.keys ?? []
    const bad = keys.find((k) => !/^[^\d\s]$/u.test(k.key))
    if (bad) return `key ${JSON.stringify(bad.key)}: a key is one printable character, not a digit`
    if (new Set(keys.map((k) => k.key)).size !== keys.length) return `section at ${s.at}: a key is used twice`
  }
  return undefined
}

const isSelectChoice = (v: unknown): v is SelectChoice =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { option?: unknown }).option === "string" &&
  ((v as { key?: unknown }).key === undefined || typeof (v as { key?: unknown }).key === "string")

const isOther = (v: unknown): v is { other: string } =>
  typeof v === "object" && v !== null && typeof (v as { other?: unknown }).other === "string"

/** What names an ask request: its only question, or how many there are. */
export function askTitle(questions: AskQuestion[]): string {
  return questions.length === 1 ? (questions[0]?.question ?? "") : `${questions.length} questions`
}
