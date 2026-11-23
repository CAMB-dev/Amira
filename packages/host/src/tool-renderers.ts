import type { ToolPresenter } from "@amira/api"

type Decorate = (below: ToolPresenter<any, any> | undefined) => ToolPresenter<any, any>

/** A presenter, or a decorator of the presenter below it (ExtensionAPI.decorateToolRenderer). */
type Entry = { presenter: ToolPresenter<any, any> } | { decorate: Decorate }

/**
 * Tool presenters registered by extensions (D1, experimental); frontends look one up when
 * they show a call. Like tools, a name holds a stack: the last presenter registered wins and
 * removing it restores the one below. A decorator builds on whatever is below it; the result
 * is kept until the stack changes.
 */
export class ToolRendererRegistry {
  #stacks = new Map<string, Entry[]>()
  #built = new Map<string, ToolPresenter<any, any> | undefined>()

  register(toolName: string, presenter: ToolPresenter<any, any>): () => void {
    return this.#push(toolName, { presenter })
  }

  decorate(toolName: string, decorate: Decorate): () => void {
    if (typeof decorate !== "function") throw new Error("decorateToolRenderer needs a function")
    return this.#push(toolName, { decorate })
  }

  get(toolName: string): ToolPresenter<any, any> | undefined {
    if (this.#built.has(toolName)) return this.#built.get(toolName)
    let presenter: ToolPresenter<any, any> | undefined
    for (const entry of this.#stacks.get(toolName) ?? []) {
      if ("presenter" in entry) presenter = entry.presenter
      else {
        try {
          presenter = entry.decorate(presenter) ?? presenter
        } catch {
          // A decorator that throws is skipped; the presenter below stays.
        }
      }
    }
    this.#built.set(toolName, presenter)
    return presenter
  }

  #push(toolName: string, entry: Entry): () => void {
    const stack = this.#stacks.get(toolName) ?? []
    stack.push(entry)
    this.#stacks.set(toolName, stack)
    this.#built.delete(toolName)
    return () => {
      const rest = (this.#stacks.get(toolName) ?? []).filter((e) => e !== entry)
      if (rest.length) this.#stacks.set(toolName, rest)
      else this.#stacks.delete(toolName)
      this.#built.delete(toolName)
    }
  }
}
