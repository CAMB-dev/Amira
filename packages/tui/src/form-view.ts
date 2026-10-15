import {
  autoFormActions,
  checkForm,
  describeFormErrors,
  type EventMap,
  type FormActionResult,
  type FormFieldSchema,
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
import type { UiRequests } from "@amira/core"
import {
  type Component,
  Form,
  type FormFieldView,
  type FormInputValue,
  FullScreenRenderer,
  type InputEvent,
  InputReader,
  ProcessTerminal,
  type RenderContext,
  type SetupResult,
  setupTerminalInput,
  type Terminal,
  type Theme,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** Where a form's checks and actions run, and where its answer goes. */
export interface FormBackend {
  schema: FormSchema
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
    opts: { signal: AbortSignal; onProgress: (text: string) => void },
  ): Promise<FormActionResult>
  /** Hands the values over; a message when they were refused (the form stays open). */
  submit(values: FormValues): string | undefined
  cancel(): void
}

export type FormRequest = Extract<EventMap["ui.request"], { kind: "form" }>

/** A form asked through UiRequests (ui.form): checks and actions run on the host, which keeps them. */
export function uiFormBackend(ui: UiRequests, request: FormRequest): FormBackend {
  const { requestId, kind: _k, source: _s, ...schema } = request
  return {
    schema,
    validate: (values) => ui.validateForm(requestId, values) ?? {},
    autoActions: (values) => ui.autoFormActions(requestId, values),
    change: (values, previous) => ui.changeForm(requestId, values, previous),
    visible: (fieldId, values) => ui.visibleForm(requestId, fieldId, values),
    preview: (values) => ui.previewForm(requestId, values),
    beforeSubmit: (values, opts) => ui.beforeSubmitForm(requestId, values, opts),
    runAction: (id, values, opts) => ui.runFormAction(requestId, id, values, opts),
    submit: (values) => ui.respond(requestId, values),
    cancel: () => void ui.cancel(requestId),
  }
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
    cancel: () => done(undefined),
  }
}

export interface FormViewOptions {
  /** Asks for a frame, e.g. when an action reports progress. */
  requestRender: () => void
  /** Titles of dialogs waiting behind the form; shown above the buttons. */
  waiting?: () => string[]
  /** The form was submitted or cancelled; close the view. */
  onClose: () => void
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
  #confirmed: FormValues
  #closed = false
  #submitting: AbortController | undefined

  constructor(backend: FormBackend, opts: FormViewOptions) {
    this.#backend = backend
    this.#opts = opts
    const { schema } = backend
    this.#confirmed = formDefaults(schema)
    const byId = new Map(schema.fields.map((f) => [f.id, f]))
    this.form = new Form({
      title: schema.title,
      ...(schema.description !== undefined ? { description: schema.description } : {}),
      fields: schema.fields.map(toView),
      ...(schema.sections ? { sections: schema.sections } : {}),
      ...(schema.submitLabel !== undefined ? { submitLabel: schema.submitLabel } : {}),
      values: this.#confirmed,
      visible: (f, values) =>
        backend.visible?.(f.id, values as FormValues) ??
        isFieldVisible(schema, byId.get(f.id)!, values as FormValues),
      validate: (values) => backend.validate(values as FormValues),
      onSubmit: (values) => this.#submit(values),
      onCancel: () => {
        this.close()
        backend.cancel()
      },
      onAction: (id, values) => this.#run(id, values),
      onActionCancel: (id) => {
        this.#abortSubmit()
        this.#running.get(id)?.controller.abort()
      },
      preview: () => backend.preview?.(this.form.values as FormValues) ?? [],
      notice: () => {
        const titles = opts.waiting?.() ?? []
        if (!titles.length) return []
        const what = titles.length === 1 ? "1 dialog waits" : `${titles.length} dialogs wait`
        return [`${glyphs.warning} ${what} behind this form: ${titles.join(" · ")}`]
      },
    })
    // Let the renderer finish mounting before starting an action or reporting progress.
    queueMicrotask(() => this.#syncAutomatic())
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Closes the view without answering, e.g. when the request was resolved elsewhere. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#abortSubmit()
    for (const { controller } of this.#running.values()) controller.abort()
    this.#running.clear()
    this.#automatic.clear()
    this.#confirmed = {}
    this.#opts.onClose()
  }

  handleInput(e: InputEvent): boolean {
    if (this.#closed) return false
    const previous = this.form.values as FormValues
    const handled = this.form.handleInput(e)
    if (this.form.confirmingCancel) this.#abortSubmit()
    const values = this.form.values as FormValues
    if (JSON.stringify(values) !== JSON.stringify(previous)) {
      this.#abortSubmit()
      this.#apply(this.#backend.change?.(values, previous) ?? {})
    }
    this.#syncAutomatic()
    return handled
  }

  render(width: number, ctx: RenderContext): string[] {
    return this.form.render(width, ctx)
  }

  #apply(result: FormActionResult, showMessage = true): void {
    for (const [id, options] of Object.entries(result.options ?? {})) this.form.setOptions(id, options)
    if (result.values) this.form.setValues(result.values)
    if (showMessage && result.message !== undefined) this.form.setStatus(result.message, result.tone)
  }

  #abortSubmit(): void {
    this.#submitting?.abort()
    this.#submitting = undefined
  }

  #submit(values: Record<string, FormInputValue>) {
    if (this.#submitting) {
      this.form.setStatus("Checking before saving…")
      return
    }
    if (!this.#backend.beforeSubmit) {
      this.#finishSubmit(values)
      return
    }
    const controller = new AbortController()
    this.#submitting = controller
    this.form.setStatus("Checking before saving…")
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
    const problem = this.#backend.submit(values as FormValues)
    if (problem === undefined) {
      this.close()
      return
    }
    const errors = this.#backend.validate(values as FormValues)
    if (Object.keys(errors).length) this.form.setErrors(errors)
    this.form.setStatus(problem, "error")
  }

  /** Text (especially a secret) is committed on leaving its field, not on each keystroke. */
  #syncAutomatic() {
    if (this.#closed) return
    const schema = this.#backend.schema
    if (!schema.fields.some((f) => f.type === "action" && f.auto)) return
    const live = this.form.values as FormValues
    const values = { ...live }
    const focused = schema.fields.find((f) => f.id === this.form.focused)
    if (focused && ["text", "secret", "textarea", "number"].includes(focused.type)) {
      const confirmed = this.#confirmed[focused.id]
      if (confirmed === undefined) delete values[focused.id]
      else values[focused.id] = confirmed
    }
    this.#confirmed = structuredClone(values)
    const eligible = this.#backend.autoActions?.(values) ?? []
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

  #run(id: string, values: Record<string, FormInputValue>, automatic = false) {
    if (this.#running.has(id)) return
    const controller = new AbortController()
    const key = this.#actionKey(id, values as FormValues)
    const action = this.#backend.schema.fields.find((f) => f.id === id)
    if (action?.type === "action" && action.auto) {
      this.#automatic.set(id, { key, attempted: true })
    }
    const running = { controller, key, automatic }
    this.#running.set(id, running)
    this.form.setActionState(id, { running: true })
    this.#opts.requestRender()
    const onProgress = (text: string) => {
      if (controller.signal.aborted || this.#closed) return
      this.form.setActionState(id, { running: true, text })
      this.#opts.requestRender()
    }
    void this.#backend
      .runAction(id, values as FormValues, { signal: controller.signal, onProgress })
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
        if (controller.signal.aborted) {
          this.form.setActionState(id, { running: false })
          this.#opts.requestRender()
          this.#syncAutomatic()
          return
        }
        if (r.values || r.options) this.#abortSubmit()
        const previous = this.form.values as FormValues
        this.#apply(r, false)
        const values = this.form.values as FormValues
        if (JSON.stringify(previous) !== JSON.stringify(values))
          this.#apply(this.#backend.change?.(values, previous) ?? {})
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
    view.handleInput(e)
    screen.requestRender()
  })
  screen.open()
  reader.start()
  if (leftoverInput) reader.feed(leftoverInput)
  try {
    return await done
  } finally {
    reader.stop()
    screen.close()
    if (terminal instanceof ProcessTerminal) terminal.stop()
    else terminal.restore()
  }
}
