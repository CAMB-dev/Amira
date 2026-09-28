import type { ToolSpec } from "@amira/ai"
import type { ToolDefinition } from "@amira/api"

export class ToolConflictError extends Error {}

interface Registered {
  tool: ToolDefinition
  source: string
}

export class ToolRegistry {
  #tools = new Map<string, Registered>()

  /** Replacing an existing tool requires `override: true`; otherwise it is a conflict. */
  register(tool: ToolDefinition, source: string): () => void {
    const existing = this.#tools.get(tool.name)
    if (existing && !tool.override) {
      throw new ToolConflictError(
        `tool "${tool.name}" from ${source} conflicts with the one from ${existing.source}; set override: true to replace it`,
      )
    }
    const entry = { tool, source }
    this.#tools.set(tool.name, entry)
    return () => {
      if (this.#tools.get(tool.name) !== entry) return
      if (existing) this.#tools.set(tool.name, existing)
      else this.#tools.delete(tool.name)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)?.tool
  }

  /** Tools the model sees on every call. */
  active(): ToolDefinition[] {
    return [...this.#tools.values()].map((r) => r.tool).filter((t) => (t.exposure ?? "active") === "active")
  }

  specs(): ToolSpec[] {
    return this.active().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  all(): { tool: ToolDefinition; source: string }[] {
    return [...this.#tools.values()]
  }
}
