import type { ToolPresenter } from "@amira/api"

/**
 * Tool presenters registered by extensions (D1, experimental); frontends look one up when
 * they show a call. Like tools, a name holds a stack: the last presenter registered wins and
 * removing it restores the one below.
 */
export class ToolRendererRegistry {
  #stacks = new Map<string, ToolPresenter<any, any>[]>()

  register(toolName: string, presenter: ToolPresenter<any, any>): () => void {
    const stack = this.#stacks.get(toolName) ?? []
    stack.push(presenter)
    this.#stacks.set(toolName, stack)
    return () => {
      const rest = (this.#stacks.get(toolName) ?? []).filter((p) => p !== presenter)
      if (rest.length) this.#stacks.set(toolName, rest)
      else this.#stacks.delete(toolName)
    }
  }

  get(toolName: string): ToolPresenter<any, any> | undefined {
    return this.#stacks.get(toolName)?.at(-1)
  }
}
