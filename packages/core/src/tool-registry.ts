import type { ToolSpec } from "@amira/ai"
import type { ToolDefinition } from "@amira/api"
import type { ExtensionDataOwner } from "./extension-data.ts"

export class ToolConflictError extends Error {}

interface Registered {
  readonly tool: ToolDefinition
  readonly source: string
  readonly dataOwner?: ExtensionDataOwner
}

export class ToolRegistry {
  /** Per name, a stack of registrations; the last one wins. */
  #tools = new Map<string, Registered[]>()
  #disabled = new Set<string>()
  /** Set on a view: the registry it shows part of. */
  #base: ToolRegistry | undefined
  #allow: (name: string) => boolean = () => true

  /**
   * A live view of `base` limited to the names `allow` accepts, e.g. a sub-agent's tools.
   * Registering through the view registers on `base`, and the disabled set is `base`'s.
   */
  static view(
    base: ToolRegistry,
    allow: (name: string) => boolean,
    /** Tools only this view has, e.g. a sub-agent's return_result; they win over `base`'s. */
    own: ToolDefinition[] = [],
  ): ToolRegistry {
    const view = new ToolRegistry()
    view.#base = base
    view.#allow = allow
    for (const tool of own) view.#own.set(tool.name, { tool, source: "core" })
    return view
  }

  /** A view's own tools, by name. */
  #own = new Map<string, Registered>()

  /** Names of the tools only this view has (see `view`); none for a registry that is not a view. */
  ownNames(): string[] {
    return [...this.#own.keys()]
  }

  /**
   * Hides tools by name from the model. A disabled tool is not offered and calling it
   * anyway is treated as an unknown tool. Replaces any previous set.
   */
  setDisabled(names: Iterable<string>): void {
    if (this.#base) this.#base.setDisabled(names)
    else this.#disabled = new Set(names)
  }

  get disabled(): ReadonlySet<string> {
    return this.#base ? this.#base.disabled : this.#disabled
  }

  /**
   * Replacing an existing tool requires `override: true`; otherwise it is a conflict.
   * The returned function removes exactly this registration, whatever its position.
   * `dataOwner` is host-assigned context retained with this registration; core remains unowned.
   */
  register(tool: ToolDefinition, source: string, dataOwner?: ExtensionDataOwner): () => void {
    if (this.#base) return this.#base.register(tool, source, dataOwner)
    const stack = this.#tools.get(tool.name) ?? []
    const top = stack.at(-1)
    if (top && !tool.override) {
      throw new ToolConflictError(
        `tool "${tool.name}" from ${source} conflicts with the one from ${top.source}; set override: true to replace it`,
      )
    }
    const entry = Object.freeze({
      tool,
      source,
      ...(source !== "core" && dataOwner ? { dataOwner: Object.freeze({ ...dataOwner }) } : {}),
    })
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
    return this.getRegistration(name)?.tool
  }

  /** The selected definition and its host-owned context, captured as one registration. */
  getRegistration(name: string): Registered | undefined {
    const own = this.#own.get(name)
    if (own) return own
    if (this.#base) return this.#allow(name) ? this.#base.getRegistration(name) : undefined
    if (this.#disabled.has(name)) return undefined
    return this.#tools.get(name)?.at(-1)
  }

  #current(): Registered[] {
    if (this.#base) {
      const shown = this.#base
        .#current()
        .filter((r) => this.#allow(r.tool.name) && !this.#own.has(r.tool.name))
      return [...shown, ...this.#own.values()]
    }
    return [...this.#tools.values()].map((s) => s.at(-1)!)
  }

  /** Tools the model sees on every call. */
  active(): ToolDefinition[] {
    const disabled = this.disabled
    return this.#current()
      .map((r) => r.tool)
      .filter((t) => (t.exposure ?? "active") === "active" && !disabled.has(t.name))
  }

  /** Tools the model only sees by name until a session loads them (see tool_search). */
  deferred(): ToolDefinition[] {
    const disabled = this.disabled
    return this.#current()
      .map((r) => r.tool)
      .filter((t) => t.exposure === "deferred" && !disabled.has(t.name))
  }

  specs(): ToolSpec[] {
    return this.active().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  /** Every usable tool, deferred ones included, with where it came from. Disabled tools are left out. */
  all(): { tool: ToolDefinition; source: string }[] {
    const disabled = this.disabled
    return this.#current()
      .filter((r) => !disabled.has(r.tool.name))
      .map(({ tool, source }) => ({ tool, source }))
  }

  /** Every registered tool, disabled ones included, with where it came from. */
  list(): { tool: ToolDefinition; source: string; disabled: boolean }[] {
    return this.#current().map(({ tool, source }) => ({
      tool,
      source,
      disabled: this.#disabled.has(tool.name),
    }))
  }

  /** Whether a tool with this name is registered, disabled or not. */
  has(name: string): boolean {
    if (this.#own.has(name)) return true
    if (this.#base) return this.#allow(name) && this.#base.has(name)
    return this.#tools.has(name)
  }
}
