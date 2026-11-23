import type { FrontendView, ViewDefinition } from "@amira/api"

/** View kinds frontends provide themselves, which extensions cannot register. */
export const BUILTIN_VIEW_KINDS: readonly string[] = []

/**
 * Full-screen view kinds registered by extensions (experimental); a frontend looks one up when
 * a command opens it. Like tool presenters, a kind holds a stack: the last view registered
 * wins and removing it restores the one below.
 */
export class ViewRegistry {
  #stacks = new Map<string, { view: ViewDefinition; lifetime: AbortSignal }[]>()
  #owners = new WeakMap<FrontendView, AbortSignal>()

  /** Tags an opening with the extension instance that requested it, without changing the API. */
  own(view: FrontendView, lifetime: AbortSignal): FrontendView {
    const request = { ...view }
    this.#owners.set(request, lifetime)
    return request
  }

  /** Instance identity for reuse; host openings belong to the registered view's lifetime. */
  owner(view: FrontendView): AbortSignal | undefined {
    return this.#owners.get(view) ?? this.#stacks.get(view.kind)?.at(-1)?.lifetime
  }

  canOpen(view: FrontendView): boolean {
    return !this.owner(view)?.aborted && !this.#stacks.get(view.kind)?.at(-1)?.lifetime.aborted
  }

  /** Closes a mounted view synchronously when its opener or registration ends. */
  watch(view: FrontendView, close: () => void): () => void {
    const signals = new Set([this.owner(view), this.#stacks.get(view.kind)?.at(-1)?.lifetime])
    for (const signal of signals) signal?.addEventListener("abort", close, { once: true })
    return () => {
      for (const signal of signals) signal?.removeEventListener("abort", close)
    }
  }

  /** Throws for an empty kind or one the frontends own. */
  register(view: ViewDefinition, lifetime?: AbortSignal): () => void {
    const kind = view.kind
    if (!kind.trim()) throw new Error("a view needs a kind")
    if (BUILTIN_VIEW_KINDS.includes(kind)) throw new Error(`the view kind "${kind}" is built in`)
    const stack = this.#stacks.get(kind) ?? []
    const abort = new AbortController()
    const entry = { view, lifetime: lifetime ? AbortSignal.any([lifetime, abort.signal]) : abort.signal }
    stack.push(entry)
    this.#stacks.set(kind, stack)
    return () => {
      abort.abort()
      const rest = (this.#stacks.get(kind) ?? []).filter((v) => v !== entry)
      if (rest.length) this.#stacks.set(kind, rest)
      else this.#stacks.delete(kind)
    }
  }

  get(kind: string): ViewDefinition | undefined {
    return this.#stacks.get(kind)?.at(-1)?.view
  }

  /** Registered kinds, in the order they were first registered. */
  kinds(): string[] {
    return [...this.#stacks.keys()]
  }
}
