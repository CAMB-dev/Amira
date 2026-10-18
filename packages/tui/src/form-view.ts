import {
  autoFormActions,
  checkForm,
  describeFormErrors,
  type EventMap,
  type FormActionResult,
  type FormFieldSchema,
  type FormOption,
  type FormSchema,
  type FormSpec,
  type FormValues,
  formDefaults,
  isFieldVisible,
  runFormAction,
  runFormBeforeSubmit,
  runFormChange,
  toFormSchema,
} from "@amira/api"
import {
  createUiFormBackend,
  type FormDraft,
  type FormEditor,
  type FormEvaluation,
  type FormMutationResult,
  type UiRequests,
  type UiResponseAck,
} from "@amira/core"
import {
  type Component,
  Form,
  type FormFieldView,
  type FormInputValue,
  FullScreenRenderer,
  type InputEvent,
  InputReader,
  modes,
  ProcessTerminal,
  type RenderContext,
  type SetupResult,
  setupTerminalInput,
  type Terminal,
  type Theme,
} from "@amira/tui-kit"
import { operationFormBackend } from "./form-operation-backend.ts"
import { asciiGlyphs, glyphs, viewEllipsis } from "./glyphs.ts"
import { mousePasteHint } from "./mouse-labels.ts"

/** "Checking form…", spelled with an ASCII ellipsis when the active theme asks for one. */
const checking = (what: string): string => `${what}${viewEllipsis("…")}`

/**
 * Between host-composed form labels. ASCII mode uses the active separator glyph; other themes
 * keep the middle dot these labels have always used, whatever separator they configure.
 */
const formSeparator = (): string => (asciiGlyphs() ? glyphs.separator : "·")

/** Where a form's checks and actions run, and where its answer goes. */
export interface FormBackend {
  schema: FormSchema
  /** Claim editor authority once at mount, never from cached presentation reads. */
  openEditor?(options?: { signal?: AbortSignal }): FormEditor | Promise<FormEditor>
  /** Revisioned host evaluation; render reads only its last accepted presentation. */
  evaluate?(
    draft: FormDraft & { previous?: FormValues; automaticValues?: FormValues },
  ): FormEvaluation | Promise<FormEvaluation>
  /** Problems by field id; empty when the values may be submitted. */
  validate(values: FormValues): Record<string, string>
  change?(values: FormValues, previous: FormValues): FormActionResult
  visible?(fieldId: string, values: FormValues): boolean
  preview?(values: FormValues): string[]
  beforeSubmit?(
    values: FormValues,
    opts: { signal: AbortSignal; onProgress: (text: string) => void },
  ): Promise<FormActionResult>
  /** Eligible automatic actions; readiness checks remain on the host. */
  autoActions?(values: FormValues): string[]
  runAction(
    id: string,
    values: FormValues,
    opts: {
      signal: AbortSignal
      onProgress: (text: string) => void
      revision?: number
      editor?: string
      automatic?: boolean
    },
  ): Promise<FormActionResult>
  /** A view closes only after acceptance, never on disconnect or validation failure. */
  submit(
    values: FormValues,
    opts?: { signal: AbortSignal; revision: number; editor?: string },
  ): string | undefined | Promise<FormMutationResult>
  cancel:
    | ((editor?: string, revision?: number) => void)
    | ((editor?: string, revision?: number) => UiResponseAck | Promise<UiResponseAck>)
}

export type FormRequest = Extract<EventMap["ui.request"], { kind: "form" }>

/** A form asked through UiRequests (ui.form): checks and actions run on the host, which keeps them. */
export function uiFormBackend(ui: UiRequests, request: FormRequest): FormBackend {
  return operationFormBackend(createUiFormBackend(ui, request))
}

/** A form run straight from its spec, outside a session (e.g. `amira provider edit`). */
export function specFormBackend(spec: FormSpec, done: (values: FormValues | undefined) => void): FormBackend {
  const options: Record<string, NonNullable<FormActionResult["options"]>[string]> = {}
  return {
    schema: toFormSchema(spec),
    validate: (values) => checkForm(spec, values, options).errors,
    autoActions: (values) => autoFormActions(spec, values, options),
    change: (values, previous) => {
      // Change tracking needs the complete frontend snapshots, including hidden defaults.
      const result = runFormChange(spec, values, previous)
      if (result.options) Object.assign(options, result.options)
      return result
    },
    visible: (fieldId, values) => {
      const field = spec.fields.find((field) => field.id === fieldId)
      return !!field && isFieldVisible(spec, field, values)
    },
    preview: (values) => spec.preview?.(checkForm(toFormSchema(spec), values, options).values) ?? [],
    beforeSubmit: async (values, opts) => {
      const result = await runFormBeforeSubmit(spec, checkForm(spec, values, options).values, {
        signal: opts.signal,
        progress: opts.onProgress,
      })
      if (!opts.signal.aborted && result.options) Object.assign(options, result.options)
      return result
    },
    runAction: async (id, values, opts) => {
      const current = checkForm(spec, values, options).values
      const r = await runFormAction(spec, id, current, { signal: opts.signal, progress: opts.onProgress })
      if (!opts.signal.aborted && r.options) Object.assign(options, r.options)
      return r
    },
    submit: (values) => {
      const checked = checkForm(spec, values, options)
      if (Object.keys(checked.errors).length) return describeFormErrors(spec, checked.errors)
      done(checked.values)
      return undefined
    },
    cancel: () => {
      done(undefined)
    },
  }
}

export interface FormViewOptions {
  /** Asks for a frame, e.g. when an action reports progress. */
  requestRender: () => void
  /** Titles of dialogs waiting behind the form; shown above the buttons. */
  waiting?: () => string[]
  /** The form was submitted or cancelled; close the view. */
  onClose: () => void
  /** Replayed requests may be displayed, but mounting them never admits automatic actions. */
  replay?: boolean
}

/**
 * A ui.form request as a full-screen Form: fields from the schema, checks and actions through
 * the backend. Actions run one at a time per button; closing the view aborts the ones running.
 */
export class FormView implements Component {
  readonly form: Form
  #backend: FormBackend
  #opts: FormViewOptions
  #running = new Map<string, { controller: AbortController; key: string; automatic: boolean }>()
  #automatic = new Map<string, { key: string; attempted: boolean }>()
  #pendingActions = new Map<string, { revision: number; editor: string | undefined }>()
  #confirmed: FormValues
  #closed = false
  #submitting: AbortController | undefined
  #revision = 0
  #editor: string | undefined
  #ready = false
  #cancelling = 0
  #opening: Promise<void> | undefined
  #claiming: AbortController | undefined
  #evaluation: FormEvaluation | undefined
  #optionKeys = new Map<string, string>()
  #evaluating = 0
  #pendingPrevious: FormValues | undefined
  #replay: boolean
  #mounted = false
  #checkingClaimAction = false

  constructor(backend: FormBackend, opts: FormViewOptions) {
    this.#backend = backend
    this.#opts = opts
    this.#replay = opts.replay ?? false
    const { schema } = backend
    for (const field of schema.fields)
      if ("options" in field) this.#optionKeys.set(field.id, optionsKey(field.options))
    this.#confirmed = formDefaults(schema)
    const byId = new Map(schema.fields.map((f) => [f.id, f]))
    this.form = new Form({
      title: schema.title,
      ...(schema.layout !== undefined ? { layout: schema.layout } : {}),
      ...(schema.description !== undefined ? { description: schema.description } : {}),
      fields: schema.fields.map(toView),
      ...(schema.sections ? { sections: schema.sections } : {}),
      ...(schema.submitLabel !== undefined ? { submitLabel: schema.submitLabel } : {}),
      values: this.#confirmed,
      visible: (f, values) =>
        this.#evaluation?.visible[f.id] ??
        backend.visible?.(f.id, values as FormValues) ??
        isFieldVisible(schema, byId.get(f.id)!, values as FormValues),
      validate: (values) => this.#evaluation?.errors ?? backend.validate(values as FormValues),
      onSubmit: (values) => this.#submit(values),
      onCancel: () => {
        void this.#cancel()
      },
      onAction: (id, values) => this.#run(id, values),
      onActionCancel: (id) => {
        this.#abortSubmit()
        this.#running.get(id)?.controller.abort()
        if (this.#pendingActions.delete(id)) this.form.setActionState(id, { running: false })
      },
      preview: () => this.#evaluation?.preview ?? backend.preview?.(this.form.values as FormValues) ?? [],
      more: () => (asciiGlyphs() ? viewEllipsis() : undefined),
      notice: () => {
        const titles = opts.waiting?.() ?? []
        if (!titles.length) return []
        const what = titles.length === 1 ? "1 dialog waits" : `${titles.length} dialogs wait`
        return [`${glyphs.warning} ${what} behind this form: ${titles.join(` ${formSeparator()} `)}`]
      },
    })
    // Synchronous local mounts still populate the first frame; transports claim authority once.
    this.#openEditor()
    this.#mounted = true
    // Let the renderer finish mounting before starting an action or reporting progress.
    queueMicrotask(() => this.#syncAutomatic())
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Closing cancels local work; detaching releases presentation without cancelling host operations. */
  close(detach = false): void {
    if (this.#closed) return
    this.#closed = true
    // Pending admission is local work even when already admitted host operations are detached.
    this.#claiming?.abort()
    this.#claiming = undefined
    if (!detach) {
      this.#abortSubmit()
      for (const { controller } of this.#running.values()) controller.abort()
    } else this.#submitting = undefined
    this.#running.clear()
    this.#automatic.clear()
    this.#clearPendingActions()
    this.#confirmed = {}
    this.#opts.onClose()
  }

  handleInput(e: InputEvent): boolean {
    if (this.#closed) return false
    this.#syncSummaries()
    const previous = this.form.values as FormValues
    const focused = this.form.focused
    const handled = this.form.handleInput(e)
    if (this.form.confirmingCancel) this.#abortSubmit()
    const values = this.form.values as FormValues
    if (JSON.stringify(values) !== JSON.stringify(previous)) {
      this.#abortSubmit()
      this.#clearPendingActions()
      this.#revision++
      this.#replay = false
      if (this.#backend.evaluate) this.#evaluate(previous)
      else this.#apply(this.#backend.change?.(values, previous) ?? {})
    } else if (focused !== this.form.focused && this.#backend.evaluate) {
      this.#evaluate()
    }
    this.#syncAutomatic()
    return handled
  }

  render(width: number, ctx: RenderContext): string[] {
    this.#syncSummaries()
    return this.form.render(width, ctx)
  }

  #syncSummaries(): void {
    const { schema } = this.#backend
    const values = this.form.values
    this.form.setSummaries(
      (schema.summaries ?? []).flatMap((summary) => {
        const condition = summary.when
        const allowed = condition && (Array.isArray(condition.is) ? condition.is : [condition.is])
        if (condition && !allowed!.some((value) => value === values[condition.field])) return []
        return [
          {
            id: `${summary.id}:${condition ? String(values[condition.field]) : ""}`,
            label: summary.label,
            fields: summary.fields,
            text: summary.summaryFields
              .filter((id) => schema.fields.some((field) => field.id === id && field.type !== "secret"))
              .map((id) => String(values[id] ?? ""))
              .filter(Boolean)
              .join(` ${formSeparator()} `),
          },
        ]
      }),
    )
  }

  #openEditor(): void {
    const controller = new AbortController()
    this.#claiming = controller
    const apply = (claim?: FormEditor) => {
      this.#claiming = undefined
      if (this.#closed) return
      this.#editor = claim?.editor
      this.#revision += claim?.revision ?? 0
      this.#ready = true
      if (this.#checkingClaimAction) {
        this.#checkingClaimAction = false
        this.form.setStatus(undefined)
      }
      this.#evaluate()
    }
    const failed = (error: unknown) => {
      this.#claiming = undefined
      if (this.#closed) return
      this.#checkingClaimAction = false
      this.form.setStatus(error instanceof Error ? error.message : String(error), "error")
      if (this.#mounted) this.#opts.requestRender()
    }
    try {
      const claim = this.#backend.openEditor?.({ signal: controller.signal })
      if (claim instanceof Promise) this.#opening = claim.then(apply, failed)
      else apply(claim)
    } catch (error) {
      failed(error)
    }
  }

  #evaluate(previous?: FormValues): void {
    if (!this.#backend.evaluate || this.#closed) return
    if (previous && !this.#pendingPrevious) this.#pendingPrevious = previous
    if (!this.#ready) return
    const revision = this.#revision
    const sequence = ++this.#evaluating
    const draft = {
      editor: this.#editor,
      revision,
      values: structuredClone(this.form.values as FormValues),
      automaticValues: this.#automaticValues(),
      ...(this.#pendingPrevious ? { previous: this.#pendingPrevious } : {}),
    }
    const apply = (result: FormEvaluation) => {
      if (
        this.#closed ||
        sequence !== this.#evaluating ||
        revision !== this.#revision ||
        result.revision !== revision
      )
        return
      this.#evaluation = result
      this.#pendingPrevious = undefined
      this.#apply(result.change)
      this.form.setValues({}) // Refresh touched-field errors from the accepted cache.
      if (JSON.stringify(this.form.values) !== JSON.stringify(draft.values)) {
        this.#clearPendingActions()
        this.#revision++
        this.#evaluate()
      }
      // Manual intent takes precedence over automatic replay of the same action.
      for (const [id, intent] of this.#pendingActions) {
        this.#pendingActions.delete(id)
        this.form.setActionState(id, { running: false })
        if (intent.revision === this.#revision && intent.editor === this.#editor)
          this.#run(id, this.form.values)
      }
      if (this.#mounted) this.#opts.requestRender()
      this.#syncAutomatic()
    }
    const failed = (error: unknown) => {
      if (this.#closed || sequence !== this.#evaluating) return
      this.#clearPendingActions()
      this.form.setStatus(error instanceof Error ? error.message : String(error), "error")
      if (this.#mounted) this.#opts.requestRender()
    }
    try {
      const result = this.#backend.evaluate(draft)
      if (result instanceof Promise) void result.then(apply, failed)
      else apply(result)
    } catch (error) {
      failed(error)
    }
  }

  async #cancel(): Promise<void> {
    if (this.#opening) await this.#opening
    if (this.#closed || !this.#ready) return
    const sequence = ++this.#cancelling
    const revision = this.#revision
    const editor = this.#editor
    const current = () =>
      !this.#closed && sequence === this.#cancelling && revision === this.#revision && editor === this.#editor
    try {
      const result = this.#backend.cancel(editor, revision)
      const ack = result instanceof Promise ? await result : result
      if (!current()) return
      if (!ack || typeof ack !== "object" || ["accepted", "cancelled", "settled"].includes(ack.status))
        this.close()
      else if ("message" in ack) this.form.setStatus(ack.message, "error")
    } catch (error) {
      if (!current()) return
      this.form.setStatus(error instanceof Error ? error.message : String(error), "error")
    }
    this.#opts.requestRender()
  }

  #apply(result: FormActionResult, showMessage = true): void {
    for (const [id, options] of Object.entries(result.options ?? {})) {
      const key = optionsKey(options)
      // Repeated host snapshots must not reset checklist highlight and scroll.
      if (this.#optionKeys.get(id) === key) continue
      this.#optionKeys.set(id, key)
      this.form.setOptions(id, options)
    }
    if (result.values) this.form.setValues(result.values)
    if (showMessage && result.message !== undefined) this.form.setStatus(result.message, result.tone)
  }

  #abortSubmit(): void {
    this.#submitting?.abort()
    this.#submitting = undefined
  }

  #submit(values: Record<string, FormInputValue>) {
    if (!this.#ready || (this.#backend.evaluate && this.#evaluation?.revision !== this.#revision)) {
      this.form.setStatus(checking("Checking form"))
      this.#opts.requestRender()
      return
    }
    if (this.#submitting) {
      this.form.setStatus(checking("Checking before saving"))
      return
    }
    if (!this.#backend.beforeSubmit) {
      this.#finishSubmit(values)
      return
    }
    const controller = new AbortController()
    this.#submitting = controller
    this.form.setStatus(checking("Checking before saving"))
    this.#opts.requestRender()
    void this.#backend
      .beforeSubmit(values as FormValues, {
        signal: controller.signal,
        onProgress: (text) => {
          if (this.#closed || controller.signal.aborted) return
          this.form.setStatus(text)
          this.#opts.requestRender()
        },
      })
      .catch(
        (error): FormActionResult => ({
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        }),
      )
      .then((result) => {
        if (this.#submitting !== controller) return
        this.#submitting = undefined
        if (this.#closed || controller.signal.aborted || this.form.confirmingCancel) return
        this.#apply(result)
        if (result.tone !== "error") this.#finishSubmit(this.form.values)
        else this.#syncAutomatic()
        this.#opts.requestRender()
      })
  }

  #finishSubmit(values: Record<string, FormInputValue>): void {
    if (this.#closed || this.form.confirmingCancel) return
    const controller = new AbortController()
    const revision = this.#revision
    const problem = this.#backend.submit(values as FormValues, {
      signal: controller.signal,
      revision,
      editor: this.#editor,
    })
    if (problem instanceof Promise) {
      this.#submitting = controller
      this.form.setStatus(checking("Checking before saving"))
      void problem.then(
        (reply) => {
          if (
            this.#closed ||
            controller.signal.aborted ||
            revision !== this.#revision ||
            reply.revision !== revision
          )
            return
          this.#submitting = undefined
          if (reply.status === "accepted" || reply.status === "settled" || reply.status === "cancelled")
            this.close()
          else {
            const previous = this.form.values as FormValues
            if (reply.result) this.#apply(reply.result)
            if (JSON.stringify(previous) !== JSON.stringify(this.form.values)) {
              this.#clearPendingActions()
              this.#revision++
            }
            this.#evaluate()
            if (reply.message) this.form.setStatus(reply.message, "error")
          }
          this.#opts.requestRender()
        },
        (error) => {
          if (this.#closed || controller.signal.aborted || revision !== this.#revision) return
          this.#submitting = undefined
          this.form.setStatus(error instanceof Error ? error.message : String(error), "error")
          this.#opts.requestRender()
        },
      )
    } else if (problem === undefined) this.close()
    else {
      const errors = this.#evaluation?.errors ?? this.#backend.validate(values as FormValues)
      if (Object.keys(errors).length) this.form.setErrors(errors)
      this.form.setStatus(problem, "error")
    }
  }

  /** Text (especially a secret) is committed on leaving its field, not on each keystroke. */
  #syncAutomatic() {
    if (this.#closed || this.#replay || !this.#mounted || !this.#ready) return
    const schema = this.#backend.schema
    if (!schema.fields.some((f) => f.type === "action" && f.auto)) return
    const live = this.form.values as FormValues
    const values = this.#automaticValues()
    this.#confirmed = structuredClone(values)
    const eligible = this.#backend.evaluate
      ? this.#evaluation?.revision === this.#revision
        ? this.#evaluation.autoActions
        : []
      : (this.#backend.autoActions?.(values) ?? [])
    for (const action of schema.fields) {
      if (action.type !== "action" || !action.auto) continue
      const key = this.#actionKey(action.id, values)
      const liveKey = this.#actionKey(action.id, live)
      let state = this.#automatic.get(action.id)
      if (!state || state.key !== key) {
        state = { key, attempted: false }
        this.#automatic.set(action.id, state)
      }
      const ready = eligible.includes(action.id)
      const running = this.#running.get(action.id)
      if (running && ((running.automatic && !ready) || running.key !== key)) {
        running.controller.abort()
        // An interrupted attempt produced no usable result, even if the edit is reverted.
        state.attempted = false
      }
      if (running || !ready || liveKey !== key || state.attempted) continue
      this.#run(action.id, structuredClone(values), true)
    }
  }

  #automaticValues(): FormValues {
    const values = { ...this.form.values } as FormValues
    const focused = this.#backend.schema.fields.find((field) => field.id === this.form.focused)
    if (focused && ["text", "secret", "textarea", "number"].includes(focused.type)) {
      const confirmed = this.#confirmed[focused.id]
      if (confirmed === undefined) delete values[focused.id]
      else values[focused.id] = confirmed
    }
    return values
  }

  /** A private in-memory fingerprint; secrets never reach status messages or events. */
  #actionKey(id: string, values: FormValues): string {
    const schema = this.#backend.schema
    const action = schema.fields.find((f) => f.id === id)
    if (action?.type !== "action" || !action.auto) return ""
    return JSON.stringify(
      action.auto.watch.map((dependency) => {
        const name = typeof dependency === "string" ? dependency : dependency.field
        const applies =
          typeof dependency === "string" ||
          Object.entries(dependency.when).every(([field, value]) => values[field] === value)
        const field = schema.fields.find((f) => f.id === name)
        return applies && field && isFieldVisible(schema, field, values) ? values[name] : undefined
      }),
    )
  }

  #clearPendingActions(): void {
    for (const id of this.#pendingActions.keys()) this.form.setActionState(id, { running: false })
    this.#pendingActions.clear()
  }

  #run(id: string, values: Record<string, FormInputValue>, automatic = false) {
    if (this.#closed || this.#running.has(id) || this.#pendingActions.has(id)) return
    if (!this.#ready) {
      if (!automatic) {
        this.#checkingClaimAction = true
        this.form.setStatus(checking("Checking form"))
        this.#opts.requestRender()
      }
      return
    }
    if (this.#backend.evaluate && this.#evaluation?.revision !== this.#revision) {
      if (!automatic) {
        this.#pendingActions.set(id, { revision: this.#revision, editor: this.#editor })
        this.form.setActionState(id, { running: true, text: checking("Checking form") })
        this.#opts.requestRender()
      }
      return
    }
    const controller = new AbortController()
    const key = this.#actionKey(id, values as FormValues)
    const action = this.#backend.schema.fields.find((f) => f.id === id)
    if (action?.type === "action" && action.auto) {
      this.#automatic.set(id, { key, attempted: true })
    }
    const revision = this.#revision
    const running = { controller, key, automatic }
    this.#running.set(id, running)
    this.form.setActionState(id, { running: true })
    this.#opts.requestRender()
    const onProgress = (text: string) => {
      if (
        controller.signal.aborted ||
        this.#closed ||
        (this.#backend.evaluate && revision !== this.#revision)
      )
        return
      this.form.setActionState(id, { running: true, text })
      this.#opts.requestRender()
    }
    void this.#backend
      .runAction(id, values as FormValues, {
        signal: controller.signal,
        onProgress,
        revision,
        editor: this.#editor,
        automatic,
      })
      .catch(
        (err): FormActionResult => ({
          message: err instanceof Error ? err.message : String(err),
          tone: "error",
        }),
      )
      .then((r) => {
        if (this.#running.get(id) !== running) return
        this.#running.delete(id)
        if (this.#closed) return
        if (controller.signal.aborted || (this.#backend.evaluate && revision !== this.#revision)) {
          if (automatic && revision !== this.#revision && this.#automatic.get(id)?.key === key)
            this.#automatic.delete(id)
          this.form.setActionState(id, { running: false })
          this.#opts.requestRender()
          this.#syncAutomatic()
          return
        }
        if (r.values || r.options) this.#abortSubmit()
        const previous = this.form.values as FormValues
        this.#apply(r, false)
        const values = this.form.values as FormValues
        if (JSON.stringify(previous) !== JSON.stringify(values)) {
          this.#clearPendingActions()
          this.#revision++
          if (this.#backend.evaluate) this.#evaluate(previous)
          else this.#apply(this.#backend.change?.(values, previous) ?? {})
        } else if (this.#backend.evaluate) this.#evaluate()
        this.form.setActionState(id, {
          running: false,
          ...(r.message !== undefined ? { text: r.message } : {}),
          ...(r.tone ? { tone: r.tone } : {}),
        })
        this.#opts.requestRender()
        this.#syncAutomatic()
      })
  }
}

function optionsKey(options: FormOption[]): string {
  return JSON.stringify(
    options.map(({ value, group, label, description, detail }) => [value, group, label, description, detail]),
  )
}

function toView(f: FormFieldSchema): FormFieldView {
  return {
    id: f.id,
    type: f.type,
    label: f.label,
    ...(f.help !== undefined ? { help: f.help } : {}),
    ...(f.section !== undefined ? { section: f.section } : {}),
    ...("required" in f && f.required ? { required: true } : {}),
    ...("placeholder" in f && f.placeholder !== undefined ? { placeholder: f.placeholder } : {}),
    ...("options" in f ? { options: f.options } : {}),
    ...(f.type === "multiselect" && f.allowCustom ? { allowCustom: true } : {}),
    ...(f.type === "textarea" && f.rows !== undefined ? { rows: f.rows } : {}),
    ...(f.type === "action" && f.placement !== undefined ? { placement: f.placement } : {}),
    ...(f.type === "action" && f.buttonLabel !== undefined ? { buttonLabel: f.buttonLabel } : {}),
    ...(f.type === "action" && f.shortcut !== undefined ? { shortcut: f.shortcut } : {}),
    ...(f.type === "action" && f.inline !== undefined ? { inline: f.inline } : {}),
  }
}

export interface FormScreenOptions {
  terminal?: Terminal
  /** Terminal setup; injectable for tests. Defaults to probing the real terminal. */
  setup?: (terminal: Terminal) => Promise<SetupResult>
  theme?: Theme
}

/**
 * Runs a form on its own, full screen, outside an interactive session (e.g. `amira provider
 * edit`): resolves with the values, or undefined when cancelled. The terminal is restored
 * afterwards.
 */
export async function runFormScreen(
  spec: FormSpec,
  opts: FormScreenOptions = {},
): Promise<FormValues | undefined> {
  const terminal = opts.terminal ?? new ProcessTerminal()
  const { capabilities, leftoverInput } = await (opts.setup ?? setupTerminalInput)(terminal)
  let finish!: (v: FormValues | undefined) => void
  const done = new Promise<FormValues | undefined>((r) => {
    finish = r
  })
  let answer: FormValues | undefined
  const view = new FormView(
    specFormBackend(spec, (v) => {
      answer = v
    }),
    {
      requestRender: () => screen.requestRender(),
      onClose: () => finish(answer),
    },
  )
  const screen = new FullScreenRenderer(terminal, view, {
    synchronizedOutput: capabilities.synchronizedOutput,
    ...(opts.theme ? { theme: opts.theme } : {}),
  })
  const reader = new InputReader(terminal, (e) => {
    const hint = mousePasteHint(e)
    if (hint) view.form.setStatus(hint)
    else view.handleInput(e)
    screen.requestRender()
  })
  screen.open()
  terminal.enableMode(modes.mouse)
  reader.start()
  if (leftoverInput) reader.feed(leftoverInput)
  try {
    return await done
  } finally {
    reader.stop()
    terminal.disableMode(modes.mouse)
    screen.close()
    if (terminal instanceof ProcessTerminal) terminal.stop()
    else terminal.restore()
  }
}
