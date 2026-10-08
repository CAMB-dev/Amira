/**
 * Forms (ui.form): a declarative list of fields a frontend shows at once, as a full-screen
 * form in the TUI, as a schema rpc clients answer, or as one dialog per field where neither
 * is possible (runFormDialogs). The parts that cannot travel (validators, actions) stay with
 * the asker; frontends reach them through the host.
 */

/** A value of one field: text, number, choice, choices or checkbox. */
export type FormValue = string | number | boolean | string[]

/** Field values by field id. */
export type FormValues = Record<string, FormValue>

export interface FormOption {
  value: string
  /** Shown instead of `value`. */
  label?: string
  /** A short muted note after the label, e.g. "128k context · $0.27/M in". */
  description?: string
}

/** What a field or form validator returns: a message, or undefined when the value is fine. */
export type FieldValidator<T> = (value: T, values: FormValues) => string | undefined

interface FieldBase {
  /** Key of the field's value. Letters, digits and `_ - .`. */
  id: string
  label: string
  /** A line under the field. */
  help?: string
  /** Title of the section the field belongs to (see FormSpec.sections); fields of one section stay together. */
  section?: string
  /**
   * Shown (and its value returned) only while field `field` has one of the values in `is`.
   * A hidden field is skipped and left out of the result.
   */
  when?: { field: string; is: FormValue | FormValue[] }
}

export interface TextField extends FieldBase {
  type: "text"
  default?: string
  placeholder?: string
  /** Not blank. */
  required?: boolean
  /** A regular expression (JavaScript syntax) the whole value must match when not empty. */
  pattern?: string
  /** Said when `pattern` does not match. Default "has the wrong format". */
  patternMessage?: string
  maxLength?: number
  validate?: FieldValidator<string>
}

/**
 * Masked input for passwords and API keys. It never has a default: its value never travels
 * to a frontend, and frontends must not persist or echo it (ui.resolved leaves form values
 * out, and action results cannot set it).
 */
export interface SecretField extends FieldBase {
  type: "secret"
  placeholder?: string
  required?: boolean
  validate?: FieldValidator<string>
}

/** A number; left empty it is missing from the result unless required. */
export interface NumberField extends FieldBase {
  type: "number"
  default?: number
  placeholder?: string
  required?: boolean
  min?: number
  max?: number
  integer?: boolean
  validate?: FieldValidator<number | undefined>
}

/** One of `options`. Without a default the first option is chosen. */
export interface SelectField extends FieldBase {
  type: "select"
  options: FormOption[]
  default?: string
  validate?: FieldValidator<string>
}

/** Any of `options` (a checklist); `allowCustom` lets the user add values of their own. */
export interface MultiSelectField extends FieldBase {
  type: "multiselect"
  options: FormOption[]
  default?: string[]
  /** At least one. */
  required?: boolean
  allowCustom?: boolean
  validate?: FieldValidator<string[]>
}

export interface CheckboxField extends FieldBase {
  type: "checkbox"
  default?: boolean
  validate?: FieldValidator<boolean>
}

/** Text of several lines. */
export interface TextareaField extends FieldBase {
  type: "textarea"
  default?: string
  placeholder?: string
  required?: boolean
  /** Rows shown before it scrolls. Default 4. */
  rows?: number
  maxLength?: number
  validate?: FieldValidator<string>
}

/**
 * A button inside the form that runs `run` with the values so far, e.g. "Fetch models" or
 * "Test connection". It has no value of its own; its result can fill in other fields.
 */
export interface ActionField extends FieldBase {
  type: "action"
  run: (ctx: FormActionContext) => Promise<FormActionResult | undefined>
  /**
   * Where a form is asked one field at a time, the question whether to run it defaults to yes.
   * Without it the default is no, which suits actions with side effects or costs.
   */
  recommended?: boolean
  /** Full-screen forms may run this action when ready; the callback stays with the host. */
  auto?: {
    /** Visible dependencies; conditions travel to frontends and must never contain secret values. */
    watch: Array<string | { field: string; when: Record<string, FormValue> }>
    /** Checks readiness without starting the action or requiring the whole form to be valid. */
    ready: (values: FormValues) => boolean
  }
}

export type FormField =
  | TextField
  | SecretField
  | NumberField
  | SelectField
  | MultiSelectField
  | CheckboxField
  | TextareaField
  | ActionField

export type FormFieldType = FormField["type"]

export interface FormActionContext {
  /** The values so far, secret ones included; hidden fields are left out. */
  values: FormValues
  /** Aborted when the user cancels the action or the form closes. */
  signal: AbortSignal
  /** Shows a progress line under the button. Never pass a secret: it is sent to frontends. */
  progress(text: string): void
}

export type FormTone = "info" | "success" | "warning" | "error"

export interface FormActionResult {
  /** Shown under the button. Never include a secret. */
  message?: string
  tone?: FormTone
  /** New values for fields (secret fields cannot be set). */
  values?: FormValues
  /** New options for select and multiselect fields, by field id. */
  options?: Record<string, FormOption[]>
}

export interface FormSection {
  title: string
  help?: string
  /**
   * Where a form is asked one field at a time, first ask whether to fill this section at all;
   * skipped fields keep their defaults. For sections of rarely needed fields.
   */
  optional?: boolean
}

/** What `ui.form` takes. */
export interface FormSpec {
  title: string
  /** Text under the title. */
  description?: string
  fields: FormField[]
  sections?: FormSection[]
  /** Default "Save". */
  submitLabel?: string
  /** Checks the whole form; returns messages by field id. Runs where the form was asked. */
  validate?: (values: FormValues) => Record<string, string> | undefined
}

type Serializable<F> = F extends ActionField
  ? Omit<F, "run" | "validate" | "auto"> & { auto?: { watch: NonNullable<F["auto"]>["watch"] } }
  : F extends { validate?: unknown }
    ? Omit<F, "validate">
    : F

/** A field as frontends receive it: no validator, no action callback. */
export type FormFieldSchema = { [T in FormField as T["type"]]: Serializable<T> }[FormFieldType]

/** A form as it travels to frontends in ui.request (kind "form"). */
export interface FormSchema {
  title: string
  description?: string
  fields: FormFieldSchema[]
  sections?: FormSection[]
  submitLabel?: string
}

/** Drops what cannot be sent to a frontend: validators and action callbacks. */
export function toFormSchema(spec: FormSpec): FormSchema {
  const fields = spec.fields.map((f) => {
    const { validate: _v, ...rest } = f as FormField & { validate?: unknown }
    if (rest.type === "action") {
      const { run: _r, auto, ...action } = rest as ActionField
      return { ...action, ...(auto ? { auto: { watch: structuredClone(auto.watch) } } : {}) }
    }
    return rest
  }) as FormFieldSchema[]
  return {
    title: spec.title,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    fields,
    ...(spec.sections ? { sections: spec.sections } : {}),
    ...(spec.submitLabel !== undefined ? { submitLabel: spec.submitLabel } : {}),
  }
}

type AnyField = FormField | FormFieldSchema

/** The value a field starts with; undefined for an empty number and for actions. */
export function fieldDefault(f: AnyField): FormValue | undefined {
  switch (f.type) {
    case "text":
    case "textarea":
      return f.default ?? ""
    case "secret":
      return ""
    case "number":
      return f.default
    case "select":
      return f.default ?? f.options[0]?.value ?? ""
    case "multiselect":
      return [...(f.default ?? [])]
    case "checkbox":
      return f.default ?? false
    case "action":
      return undefined
  }
}

/** Every field's starting value; empty numbers and actions have none. */
export function formDefaults(form: { fields: readonly AnyField[] }): FormValues {
  const out: FormValues = {}
  for (const f of form.fields) {
    const v = fieldDefault(f)
    if (v !== undefined) out[f.id] = v
  }
  return out
}

/** Whether a field shows, given the values so far; a field it depends on must show too. */
export function isFieldVisible(
  form: { fields: readonly AnyField[] },
  field: AnyField,
  values: FormValues,
  seen = new Set<string>(),
): boolean {
  if (!field.when) return true
  if (seen.has(field.id)) return false
  seen.add(field.id)
  const dep = form.fields.find((f) => f.id === field.when!.field)
  if (dep && !isFieldVisible(form, dep, values, seen)) return false
  const is = Array.isArray(field.when.is) ? field.when.is : [field.when.is]
  const v = values[field.when.field]
  return is.some((x) => x === v)
}

/** Ids of the secret fields, whose values must not be persisted or echoed. */
export function secretFieldIds(form: { fields: readonly AnyField[] }): string[] {
  return form.fields.filter((f) => f.type === "secret").map((f) => f.id)
}

export interface CheckedForm {
  /** The values of the fields that show, normalized; hidden fields and unknown keys dropped. */
  values: FormValues
  /** Messages by field id; empty when the form may be submitted. */
  errors: Record<string, string>
}

/**
 * Normalizes and checks values from a frontend against a form: missing fields take their
 * defaults, numbers may come as text, choices must be options (`options` overrides a field's
 * options, e.g. after an action filled them in). Validators run when `spec` has them.
 */
export function checkForm(
  form: FormSpec | FormSchema,
  input: Record<string, unknown>,
  options: Record<string, FormOption[]> = {},
): CheckedForm {
  const raw: Record<string, unknown> = { ...formDefaults(form), ...input }
  const values: FormValues = {}
  const errors: Record<string, string> = {}
  // Visibility depends on normalized values of the fields it looks at, so normalize first.
  const normalized: FormValues = {}
  for (const f of form.fields) {
    if (f.type === "action") continue
    const r = normalize(f, raw[f.id], options[f.id] ?? ("options" in f ? f.options : []))
    if (r.error) errors[f.id] = r.error
    if (r.value !== undefined) normalized[f.id] = r.value
  }
  for (const f of form.fields) {
    if (f.type === "action") continue
    if (!isFieldVisible(form, f, normalized)) {
      delete errors[f.id]
      continue
    }
    const v = normalized[f.id]
    if (v !== undefined) values[f.id] = v
    if (errors[f.id]) continue
    const problem = builtinCheck(f, v) ?? customCheck(f as FormField, v, normalized)
    if (problem) errors[f.id] = problem
  }
  if (!Object.keys(errors).length && "validate" in form && form.validate) {
    for (const [id, message] of Object.entries(form.validate(values) ?? {})) if (message) errors[id] = message
  }
  return { values, errors }
}

function normalize(
  f: Exclude<AnyField, { type: "action" }>,
  v: unknown,
  options: FormOption[],
): { value?: FormValue; error?: string } {
  switch (f.type) {
    case "text":
    case "secret":
    case "textarea":
      if (v === undefined || v === null) return { value: "" }
      return typeof v === "string" ? { value: v } : { error: "must be text" }
    case "number": {
      if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return {}
      const n = typeof v === "number" ? v : Number(String(v).replace(/[_,\s]/g, ""))
      return Number.isFinite(n) ? { value: n } : { error: "must be a number" }
    }
    case "select":
      if (typeof v !== "string") return { error: "must be one of the options" }
      return options.some((o) => o.value === v) ? { value: v } : { error: "must be one of the options" }
    case "multiselect": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { error: "must be a list" }
      const list = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))]
      const unknown = f.allowCustom ? [] : list.filter((x) => !options.some((o) => o.value === x))
      return unknown.length ? { error: `not an option: ${unknown.join(", ")}` } : { value: list }
    }
    case "checkbox":
      return typeof v === "boolean" ? { value: v } : { error: "must be true or false" }
  }
}

function builtinCheck(
  f: Exclude<AnyField, { type: "action" }>,
  v: FormValue | undefined,
): string | undefined {
  switch (f.type) {
    case "text":
    case "secret":
    case "textarea": {
      const s = v as string
      if (f.required && !s.trim()) return "is required"
      if ("maxLength" in f && f.maxLength !== undefined && s.length > f.maxLength) {
        return `is longer than ${f.maxLength} characters`
      }
      if (f.type === "text" && f.pattern && s.trim() && !new RegExp(`^(?:${f.pattern})$`).test(s.trim())) {
        return f.patternMessage ?? "has the wrong format"
      }
      return undefined
    }
    case "number": {
      if (v === undefined) return f.required ? "is required" : undefined
      const n = v as number
      if (f.integer && !Number.isInteger(n)) return "must be a whole number"
      if (f.min !== undefined && n < f.min) return `must be at least ${f.min}`
      if (f.max !== undefined && n > f.max) return `must be at most ${f.max}`
      return undefined
    }
    case "multiselect":
      return f.required && !(v as string[]).length ? "pick at least one" : undefined
    default:
      return undefined
  }
}

function customCheck(f: FormField, v: FormValue | undefined, values: FormValues): string | undefined {
  if (f.type === "action" || !f.validate) return undefined
  try {
    return (f.validate as FieldValidator<FormValue | undefined>)(v, values)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** "id: message; id: message", in field order, with labels. */
export function describeFormErrors(
  form: { fields: readonly AnyField[] },
  errors: Record<string, string>,
): string {
  const label = (id: string) => form.fields.find((f) => f.id === id)?.label ?? id
  return Object.entries(errors)
    .map(([id, m]) => `${label(id)}: ${m}`)
    .join("; ")
}

/** Visible automatic actions ready for the values so far; does not run actions or validators. */
export function autoFormActions(
  spec: FormSpec,
  values: Record<string, unknown>,
  options: Record<string, FormOption[]> = {},
): string[] {
  const checked = checkForm(toFormSchema(spec), values, options).values
  return spec.fields
    .filter(
      (f): f is ActionField =>
        f.type === "action" && !!f.auto && isFieldVisible(spec, f, checked) && f.auto.ready(checked),
    )
    .map((f) => f.id)
}

/** Runs one of a form's actions, catching failures into an error result. */
export async function runFormAction(
  spec: FormSpec,
  actionId: string,
  values: FormValues,
  ctx: Omit<FormActionContext, "values">,
): Promise<FormActionResult> {
  const action = spec.fields.find((f): f is ActionField => f.type === "action" && f.id === actionId)
  if (!action) return { message: `no action "${actionId}"`, tone: "error" }
  if (!isFieldVisible(spec, action, values))
    return { message: `"${action.label}" is not shown`, tone: "error" }
  try {
    const result = (await action.run({ ...ctx, values })) ?? {}
    return safeActionResult(spec, result)
  } catch (err) {
    if (ctx.signal.aborted) return { message: "Cancelled.", tone: "warning" }
    return { message: err instanceof Error ? err.message : String(err), tone: "error" }
  }
}

/** An action result without values for secret or unknown fields. */
function safeActionResult(spec: FormSpec, r: FormActionResult): FormActionResult {
  const out: FormActionResult = { ...r }
  if (r.values) {
    const settable = new Set(
      spec.fields.filter((f) => f.type !== "secret" && f.type !== "action").map((f) => f.id),
    )
    out.values = Object.fromEntries(Object.entries(r.values).filter(([id]) => settable.has(id)))
  }
  if (r.options) {
    const choosable = new Set(
      spec.fields.filter((f) => f.type === "select" || f.type === "multiselect").map((f) => f.id),
    )
    out.options = Object.fromEntries(Object.entries(r.options).filter(([id]) => choosable.has(id)))
  }
  return out
}

/** The dialogs runFormDialogs asks with; every UiApi has them. */
export interface FormDialogs {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>
  input(
    title: string,
    opts?: { signal?: AbortSignal; placeholder?: string; initial?: string; secret?: boolean },
  ): Promise<string | undefined>
}

const YES = "Yes"
const NO = "No"
const DONE = "Done"
const TYPE_IDS = "Add values…"
const SAVE_TRIES = 5

/**
 * Asks a form one field at a time with select and input dialogs, for frontends that cannot
 * show a form: text as input, choices and checkboxes as selects, a checklist as a select that
 * toggles one option per answer, and each action as "Run it? No/Yes" (Yes first when
 * `recommended`). An invalid answer is asked again with the problem in the title. It ends
 * with a Save/Cancel choice; resolves undefined when any dialog is cancelled.
 */
export async function runFormDialogs(
  spec: FormSpec,
  ui: FormDialogs,
  opts: { signal?: AbortSignal } = {},
): Promise<FormValues | undefined> {
  const signal = opts.signal
  const values = formDefaults(spec)
  const options: Record<string, FormOption[]> = {}
  /** A result to show with the next question. */
  let note = ""
  const titled = (title: string) => {
    const t = note ? `${note}\n${title}` : title
    note = ""
    return t
  }
  const skipped = new Set<string>()
  const optional = new Map((spec.sections ?? []).filter((s) => s.optional).map((s) => [s.title, s]))
  for (const field of spec.fields) {
    if (!isFieldVisible(spec, field, values)) continue
    if (field.section && optional.has(field.section)) {
      const section = optional.get(field.section)!
      optional.delete(field.section)
      const q = `${section.title}: set these now?${section.help ? ` (${section.help})` : ""}`
      const a = await ui.select(titled(q), [NO, YES], { signal })
      if (a === undefined) return undefined
      if (a === NO) skipped.add(section.title)
    }
    if (field.section && skipped.has(field.section)) continue
    if (field.type === "action") {
      const help = field.help ? ` ${field.help}` : ""
      const a = await ui.select(titled(`${field.label}?${help}`), field.recommended ? [YES, NO] : [NO, YES], {
        signal,
      })
      if (a === undefined) return undefined
      if (a === NO) continue
      const r = await runFormAction(spec, field.id, values, {
        signal: signal ?? new AbortController().signal,
        progress: () => {},
      })
      if (r.values) Object.assign(values, r.values)
      if (r.options) Object.assign(options, r.options)
      if (r.message) note = r.tone === "error" ? `✗ ${r.message}` : r.message
      continue
    }
    if (!(await ask(field, ""))) return undefined
  }
  for (let i = 0; i < SAVE_TRIES; i++) {
    const checked = checkForm(spec, values, options)
    const bad = spec.fields.filter(
      (f): f is Exclude<FormField, ActionField> => f.type !== "action" && checked.errors[f.id] !== undefined,
    )
    if (bad.length) {
      for (const f of bad) if (!(await ask(f, `✗ ${checked.errors[f.id]}`))) return undefined
      continue
    }
    if (Object.keys(checked.errors).length) {
      // A form-level problem no field can fix.
      note = `✗ ${describeFormErrors(spec, checked.errors)}`
      await ui.select(titled(`${spec.title}: cannot be saved`), ["Cancel"], { signal })
      return undefined
    }
    const submit = spec.submitLabel ?? "Save"
    const a = await ui.select(titled(`${spec.title}: ${submit}?`), [submit, "Cancel"], { signal })
    if (a === undefined || a === "Cancel") return undefined
    return checked.values
  }
  return undefined

  /** Asks one field until its answer passes; false when cancelled. */
  async function ask(field: Exclude<FormField, ActionField>, problem: string): Promise<boolean> {
    for (;;) {
      const answer = await askField(spec, field, values, options, ui, titled, problem, signal)
      if (answer === CANCEL) return false
      const next = { ...values }
      if (answer === undefined) delete next[field.id]
      else next[field.id] = answer
      const checked = checkForm(spec, next, options)
      const error = checked.errors[field.id]
      if (!error) {
        const v = checked.values[field.id]
        if (v === undefined) delete values[field.id]
        else values[field.id] = v
        return true
      }
      problem = `✗ ${error}`
    }
  }
}

const CANCEL = Symbol("cancel")

async function askField(
  spec: FormSpec,
  field: Exclude<FormField, ActionField>,
  values: FormValues,
  options: Record<string, FormOption[]>,
  ui: FormDialogs,
  titled: (t: string) => string,
  problem: string,
  signal: AbortSignal | undefined,
): Promise<FormValue | undefined | typeof CANCEL> {
  const help = field.help ? ` (${field.help})` : ""
  const title = () => titled(`${problem ? `${problem}\n` : ""}${spec.title} · ${field.label}${help}`)
  const current = values[field.id]
  const opts = (f: SelectField | MultiSelectField) => options[f.id] ?? f.options
  const label = (o: FormOption) => o.label ?? o.value
  switch (field.type) {
    case "text":
    case "textarea":
    case "secret":
    case "number": {
      const initial = field.type === "secret" || current === undefined ? undefined : String(current)
      const a = await ui.input(title(), {
        ...(signal ? { signal } : {}),
        ...("placeholder" in field && field.placeholder !== undefined
          ? { placeholder: field.placeholder }
          : {}),
        ...(initial !== undefined && initial !== "" ? { initial } : {}),
        ...(field.type === "secret" ? { secret: true } : {}),
      })
      if (a === undefined) return CANCEL
      if (field.type === "number") return a.trim() ? a : undefined
      return a
    }
    case "checkbox": {
      const on = current === true
      const a = await ui.select(title(), on ? [YES, NO] : [NO, YES], signal ? { signal } : {})
      return a === undefined ? CANCEL : a === YES
    }
    case "select": {
      const list = opts(field)
      const labels = list.map(label)
      // The current choice first, so Enter keeps it.
      const at = Math.max(
        0,
        list.findIndex((o) => o.value === current),
      )
      const order = [at, ...labels.map((_, i) => i).filter((i) => i !== at)]
      const a = await ui.select(
        title(),
        order.map((i) => labels[i]!),
        signal ? { signal } : {},
      )
      if (a === undefined) return CANCEL
      return list[labels.indexOf(a)]?.value ?? a
    }
    case "multiselect": {
      const picked = new Set(Array.isArray(current) ? current : [])
      let first = true
      for (;;) {
        const list = opts(field)
        const all = [
          ...list.map((o) => o.value),
          ...[...picked].filter((v) => !list.some((o) => o.value === v)),
        ]
        const row = (v: string) => {
          const o = list.find((x) => x.value === v)
          return `${picked.has(v) ? "[x]" : "[ ]"} ${o ? label(o) : v}`
        }
        const rows = all.map(row)
        const choices = [DONE, ...(field.allowCustom ? [TYPE_IDS] : []), ...rows]
        const summary = `${picked.size} picked`
        const a = await ui.select(
          first ? title() : `${spec.title} · ${field.label} (${summary}; pick one to toggle it)`,
          choices,
          signal ? { signal } : {},
        )
        first = false
        if (a === undefined) return CANCEL
        if (a === DONE) return [...picked]
        if (a === TYPE_IDS) {
          const typed = await ui.input(
            `${field.label}: values to add, separated by commas or spaces`,
            signal ? { signal } : {},
          )
          if (typed === undefined) return CANCEL
          for (const v of typed.split(/[\s,]+/).filter(Boolean)) picked.add(v)
          continue
        }
        const v = all[rows.indexOf(a)]
        if (v === undefined) continue
        if (picked.has(v)) picked.delete(v)
        else picked.add(v)
      }
    }
  }
}
