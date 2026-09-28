import type { ToolSpec } from "@amira/ai"
import type { ToolDefinition } from "@amira/api"

export class ToolConflictError extends Error {}

interface Registered {
  tool: ToolDefinition
  source: string
}

export class ToolRegistry {
  /** Per name, a stack of registrations; the last one wins. */
  #tools = new Map<string, Registered[]>()
  #disabled = new Set<string>()

  /**
   * Hides tools by name from the model. A disabled tool is not offered and calling it
   * anyway is treated as an unknown tool. Replaces any previous set.
   */
  setDisabled(names: Iterable<string>): void {
    this.#disabled = new Set(names)
  }

  get disabled(): ReadonlySet<string> {
    return this.#disabled
  }

  /**
   * Replacing an existing tool requires `override: true`; otherwise it is a conflict.
   * The returned function removes exactly this registration, whatever its position.
   */
  register(tool: ToolDefinition, source: string): () => void {
    const stack = this.#tools.get(tool.name) ?? []
    const top = stack.at(-1)
    if (top && !tool.override) {
      throw new ToolConflictError(
        `tool "${tool.name}" from ${source} conflicts with the one from ${top.source}; set override: true to replace it`,
      )
    }
    const entry = { tool, source }
    stack.push(entry)
    this.#tools.set(tool.name, stack)
    return () => {
      const s = this.#tools.get(tool.name)
      if (!s) return
      const rest = s.filter((e) => e !== entry)
      if (rest.length) this.#tools.set(tool.name, rest)
      else this.#tools.delete(tool.name)
    }
  }

  get(name: string): ToolDefinition | undefined {
    if (this.#disabled.has(name)) return undefined
    return this.#tools.get(name)?.at(-1)?.tool
  }

  #current(): Registered[] {
    return [...this.#tools.values()].map((s) => s.at(-1)!)
  }

  /** Tools the model sees on every call. */
  active(): ToolDefinition[] {
    return this.#current()
      .map((r) => r.tool)
      .filter((t) => (t.exposure ?? "active") === "active" && !this.#disabled.has(t.name))
  }

  /** Tools the model only sees by name until a session loads them (see tool_search). */
  deferred(): ToolDefinition[] {
    return this.#current()
      .map((r) => r.tool)
      .filter((t) => t.exposure === "deferred" && !this.#disabled.has(t.name))
  }

  specs(): ToolSpec[] {
    return this.active().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  /** Every usable tool, deferred ones included, with where it came from. Disabled tools are left out. */
  all(): { tool: ToolDefinition; source: string }[] {
    return this.#current().filter((r) => !this.#disabled.has(r.tool.name))
  }

  /** Whether a tool with this name is registered, disabled or not. */
  has(name: string): boolean {
    return this.#tools.has(name)
  }
}
