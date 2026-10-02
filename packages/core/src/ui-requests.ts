import {
  type AskAnswer,
  type AskQuestion,
  checkForm,
  describeFormErrors,
  type EventMap,
  type FormActionResult,
  type FormOption,
  type FormSpec,
  type FormValues,
  runFormAction,
  runFormDialogs,
  type SelectChoice,
  type SelectSection,
  sectionOf,
  toFormSchema,
  type UiAnswer,
  type UiApi,
  type UiRequest,
  type UiRequestOptions,
} from "@amira/api"
import type { EventBus } from "./event-bus.ts"

type Value = UiAnswer[keyof UiAnswer]

interface Pending {
  request: EventMap["ui.request"]
  resolve: (value: Value | undefined) => void
  cleanup: () => void
  /** For a form: the spec with its validators and actions, which never leave the host. */
  form?: FormState
}

interface FormState {
  spec: FormSpec
  /** Options actions have filled in since the form was asked, by field id. */
  options: Record<string, FormOption[]>
  /** Actions running now; aborted when the form closes. */
  running: Set<AbortController>
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
  #sourceLabels = new Map<string, string>()
  #seq = 0
  formMode: FormMode = "native"
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

  /** Dialogs still waiting, oldest first. */
  get pending(): EventMap["ui.request"][] {
    return [...this.#pending.values()].map((p) => p.request)
  }

  /** Resolves with the answer, or undefined when cancelled, aborted or timed out. */
  ask<K extends Exclude<keyof UiAnswer, "form">>(
    request: Extract<UiRequest, { kind: K }>,
    opts: UiRequestOptions & { source?: string } = {},
  ): Promise<UiAnswer[K] | undefined> {
    return this.#ask(request, opts) as Promise<UiAnswer[K] | undefined>
  }

  /** Asks a form: natively, or one field at a time in `dialogs` mode. */
  form(spec: FormSpec, opts: UiRequestOptions & { source?: string } = {}): Promise<FormValues | undefined> {
    if (this.formMode === "dialogs") {
      const api = this.api(opts.source)
      const signal = timeoutSignal(opts)
      return runFormDialogs(spec, api, signal ? { signal } : {})
    }
    const form: FormState = { spec, options: {}, running: new Set() }
    return this.#ask({ kind: "form", ...toFormSchema(spec) }, opts, form) as Promise<FormValues | undefined>
  }

  #ask(request: UiRequest, opts: UiRequestOptions & { source?: string }, form?: FormState) {
    if (opts.signal?.aborted) return Promise.resolve(undefined)
    const requestId = `ui_${++this.#seq}_${crypto.randomUUID().slice(0, 6)}`
    const sourceLabel = opts.source ? this.#sourceLabels.get(opts.source) : undefined
    const event = {
      ...request,
      requestId,
      ...(opts.source ? { source: opts.source } : {}),
      ...(sourceLabel !== undefined ? { sourceLabel } : {}),
    } as EventMap["ui.request"]
    return new Promise<Value | undefined>((resolve) => {
      const onAbort = () => this.cancel(requestId)
      const timer = opts.timeoutMs !== undefined ? setTimeout(onAbort, opts.timeoutMs) : undefined
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      this.#pending.set(requestId, {
        request: event,
        resolve,
        cleanup: () => {
          clearTimeout(timer)
          opts.signal?.removeEventListener("abort", onAbort)
          for (const c of form?.running ?? []) c.abort()
        },
        ...(form ? { form } : {}),
      })
      this.#bus.emit("ui.request", event, { sessionId: this.#sessionId })
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
      const { values, errors } = checkForm(p.form.spec, value as Record<string, unknown>, p.form.options)
      if (Object.keys(errors).length) return `invalid form values: ${describeFormErrors(p.form.spec, errors)}`
      this.#settle(requestId, values)
      return undefined
    }
    const problem = checkValue(p.request, value)
    if (problem) return problem
    this.#settle(requestId, value as Value)
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

  /**
   * Runs an action of a pending form with the values so far. Progress goes out as ui.progress
   * (and to `onProgress`); the result never carries secret values. Aborted by `signal` and
   * when the form closes.
   */
  async runFormAction(
    requestId: string,
    action: string,
    values: Record<string, unknown>,
    opts: { signal?: AbortSignal; onProgress?: (text: string) => void } = {},
  ): Promise<FormActionResult> {
    const form = this.#pending.get(requestId)?.form
    if (!form) return { message: `no pending form "${requestId}"`, tone: "error" }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    if (opts.signal?.aborted) controller.abort()
    form.running.add(controller)
    // Field checks do not matter here; an action may run on a half-filled form.
    const current = checkForm(form.spec, values, form.options).values
    try {
      const result = await runFormAction(form.spec, action, current, {
        signal: controller.signal,
        progress: (text) => {
          if (controller.signal.aborted) return
          opts.onProgress?.(text)
          this.#bus.emit("ui.progress", { requestId, action, text }, { sessionId: this.#sessionId })
        },
      })
      if (result.options) Object.assign(form.options, result.options)
      return result
    } finally {
      form.running.delete(controller)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  }

  cancel(requestId: string): boolean {
    if (!this.#pending.has(requestId)) return false
    this.#settle(requestId, undefined)
    return true
  }

  /** Cancels every dialog, or only those asked by one extension. */
  cancelAll(source?: string): void {
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
        const { sections, descriptions, searchTexts, ...rest } = opts
        const problem = sectionProblem(options, sections)
        if (problem) throw new Error(`ui.choose: ${problem}`)
        const request = {
          kind: "select" as const,
          title,
          options: [...options],
          sections: structuredClone(sections),
          ...(descriptions ? { descriptions: [...descriptions] } : {}),
          ...(searchTexts ? { searchTexts: [...searchTexts] } : {}),
        }
        const answer = await this.ask(request, o(rest))
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
    }
  }

  #settle(requestId: string, value: Value | undefined) {
    const p = this.#pending.get(requestId)!
    this.#pending.delete(requestId)
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
      { sessionId: this.#sessionId },
    )
    p.resolve(value)
  }
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

/** Why `value` is no answer to `questions`: one AskAnswer each, its labels among the options. */
function checkAskAnswers(questions: AskQuestion[], value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== questions.length)
    return `value must be an array of ${questions.length} answer(s), one per question`
  for (const [i, q] of questions.entries()) {
    const a = value[i] as Partial<AskAnswer> | null
    const at = `answer ${i + 1}`
    if (typeof a !== "object" || a === null || !Array.isArray(a.selected))
      return `${at} must be an object with "selected", an array of option labels`
    if (a.other !== undefined && (typeof a.other !== "string" || !a.other.trim()))
      return `${at}: "other" must be text`
    const labels = new Set(q.options.map((o) => o.label))
    const bad = a.selected.find((l) => typeof l !== "string" || !labels.has(l))
    if (bad !== undefined) return `${at}: ${JSON.stringify(bad)} is not one of the options`
    if (new Set(a.selected).size !== a.selected.length) return `${at} names an option twice`
    const count = a.selected.length + (a.other !== undefined ? 1 : 0)
    if (!q.multiSelect && count !== 1) return `${at} must choose one option or give "other" text`
  }
  return undefined
}
