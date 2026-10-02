import type { ViewDefinition } from "@amira/api"

/** View kinds frontends provide themselves, which extensions cannot register. */
export const BUILTIN_VIEW_KINDS: readonly string[] = []

/**
 * Full-screen view kinds registered by extensions (experimental); a frontend looks one up when
 * a command opens it. Like tool presenters, a kind holds a stack: the last view registered
 * wins and removing it restores the one below.
 */
export class ViewRegistry {
  #stacks = new Map<string, ViewDefinition[]>()

  /** Throws for an empty kind or one the frontends own. */
  register(view: ViewDefinition): () => void {
    const kind = view.kind
    if (!kind.trim()) throw new Error("a view needs a kind")
    if (BUILTIN_VIEW_KINDS.includes(kind)) throw new Error(`the view kind "${kind}" is built in`)
    const stack = this.#stacks.get(kind) ?? []
    stack.push(view)
    this.#stacks.set(kind, stack)
    return () => {
      const rest = (this.#stacks.get(kind) ?? []).filter((v) => v !== view)
      if (rest.length) this.#stacks.set(kind, rest)
      else this.#stacks.delete(kind)
    }
  }

  get(kind: string): ViewDefinition | undefined {
    return this.#stacks.get(kind)?.at(-1)
  }

  /** Registered kinds, in the order they were first registered. */
  kinds(): string[] {
    return [...this.#stacks.keys()]
  }
}
