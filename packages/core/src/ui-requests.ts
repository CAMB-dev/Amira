import type { EventMap, UiAnswer, UiApi, UiRequest, UiRequestOptions } from "@amira/api"
import type { EventBus } from "./event-bus.ts"

type Value = UiAnswer[keyof UiAnswer]

interface Pending {
  request: EventMap["ui.request"]
  resolve: (value: Value | undefined) => void
  cleanup: () => void
}

/**
 * Dialogs waiting for the user (D42). Asking emits ui.request; whichever frontend is attached
 * answers with respond() or cancel(), and ui.resolved tells every frontend it is closed.
 */
export class UiRequests {
  #bus: EventBus
  #sessionId: string
  #pending = new Map<string, Pending>()
  #seq = 0

  constructor(bus: EventBus, opts: { sessionId?: string } = {}) {
    this.#bus = bus
    this.#sessionId = opts.sessionId ?? "host"
  }

  /** Dialogs still waiting, oldest first. */
  get pending(): EventMap["ui.request"][] {
    return [...this.#pending.values()].map((p) => p.request)
  }

  /** Resolves with the answer, or undefined when cancelled, aborted or timed out. */
  ask<K extends keyof UiAnswer>(
    request: Extract<UiRequest, { kind: K }>,
    opts: UiRequestOptions & { source?: string } = {},
  ): Promise<UiAnswer[K] | undefined> {
    if (opts.signal?.aborted) return Promise.resolve(undefined)
    const requestId = `ui_${++this.#seq}_${crypto.randomUUID().slice(0, 6)}`
    const event = {
      ...request,
      requestId,
      ...(opts.source ? { source: opts.source } : {}),
    } as EventMap["ui.request"]
    return new Promise((resolve) => {
      const onAbort = () => this.cancel(requestId)
      const timer = opts.timeoutMs !== undefined ? setTimeout(onAbort, opts.timeoutMs) : undefined
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      this.#pending.set(requestId, {
        request: event,
        resolve: resolve as (v: Value | undefined) => void,
        cleanup: () => {
          clearTimeout(timer)
          opts.signal?.removeEventListener("abort", onAbort)
        },
      })
      this.#bus.emit("ui.request", event, { sessionId: this.#sessionId })
    })
  }

  /**
   * Answers a dialog. null or undefined cancels it. Returns an error message when the
   * request is unknown or the value does not fit its kind; the dialog then stays open.
   */
  respond(requestId: string, value: unknown): string | undefined {
    const p = this.#pending.get(requestId)
    if (!p) return `no pending ui request "${requestId}"`
    if (value === null || value === undefined) {
      this.cancel(requestId)
      return undefined
    }
    const problem = checkValue(p.request, value)
    if (problem) return problem
    this.#settle(requestId, value as Value)
    return undefined
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
      select: (title, options, opts) => this.ask({ kind: "select", title, options: [...options] }, o(opts)),
      confirm: (title, message, opts) =>
        this.ask({ kind: "confirm", title, ...(message !== undefined ? { message } : {}) }, o(opts)),
      input: (title, opts = {}) => {
        const { placeholder, initial, ...rest } = opts
        return this.ask(
          {
            kind: "input",
            title,
            ...(placeholder !== undefined ? { placeholder } : {}),
            ...(initial !== undefined ? { initial } : {}),
          },
          o(rest),
        )
      },
    }
  }

  #settle(requestId: string, value: Value | undefined) {
    const p = this.#pending.get(requestId)!
    this.#pending.delete(requestId)
    p.cleanup()
    this.#bus.emit(
      "ui.resolved",
      { requestId, cancelled: value === undefined, ...(value !== undefined ? { value } : {}) },
      { sessionId: this.#sessionId },
    )
    p.resolve(value)
  }
}

function checkValue(request: UiRequest, value: unknown): string | undefined {
  switch (request.kind) {
    case "select":
      return typeof value === "string" && request.options.includes(value)
        ? undefined
        : `value must be one of the options: ${JSON.stringify(request.options)}`
    case "confirm":
      return typeof value === "boolean" ? undefined : "value must be true or false"
    case "input":
      return typeof value === "string" ? undefined : "value must be a string"
  }
}
