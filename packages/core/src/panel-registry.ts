import { PANEL_MAX_LINES, type PanelDefinition, type PanelRenderOptions, type ViewLine } from "@amira/api"

/** A panel's lines as a frontend draws them: cut to PANEL_MAX_LINES, one row each. */
export interface ResolvedPanel {
  id: string
  lines: ViewLine[]
}

interface Entry {
  panel: PanelDefinition
  order: number
  seq: number
}

const KINDS = new Set<ViewLine["kind"]>([
  "text",
  "muted",
  "accent",
  "success",
  "warning",
  "error",
  "code",
  "diff-add",
  "diff-remove",
  "diff-context",
  "diff-hunk",
])

/**
 * Live panels registered by extensions (experimental); frontends call snapshot() when they
 * redraw. Like status items, an id holds a stack: `override: true` replaces the current panel
 * and removing it restores the one below.
 */
export class PanelRegistry {
  #panels = new Map<string, Entry[]>()
  #seq = 0

  /** Throws for an empty id, or one that is taken without `override`. */
  register(panel: PanelDefinition): () => void {
    if (!panel.id?.trim()) throw new Error("a panel needs an id")
    const stack = this.#panels.get(panel.id) ?? []
    if (stack.length && !panel.override) {
      throw new Error(`panel "${panel.id}" is already registered; set override: true to replace it`)
    }
    const entry = { panel, order: panel.order ?? 0, seq: this.#seq++ }
    stack.push(entry)
    this.#panels.set(panel.id, stack)
    return () => {
      const rest = (this.#panels.get(panel.id) ?? []).filter((e) => e !== entry)
      if (rest.length) this.#panels.set(panel.id, rest)
      else this.#panels.delete(panel.id)
    }
  }

  get size(): number {
    return this.#panels.size
  }

  /**
   * The visible panels in display order, each with at least one line. A panel that throws or
   * returns something other than lines is left out; control characters and line breaks are
   * made spaces, so one bad panel cannot break a frontend. A collapsed panel keeps its first
   * line; a long one is cut to PANEL_MAX_LINES, the last saying how many more there are.
   */
  snapshot(opts: PanelRenderOptions): ResolvedPanel[] {
    const out: (ResolvedPanel & { order: number; seq: number })[] = []
    for (const stack of this.#panels.values()) {
      const { panel, order, seq } = stack.at(-1)!
      let raw: unknown
      try {
        raw = panel.render(opts)
      } catch {
        continue
      }
      if (!Array.isArray(raw)) continue
      const lines: ViewLine[] = []
      for (const l of raw as unknown[]) {
        if (!l || typeof l !== "object" || typeof (l as ViewLine).text !== "string") continue
        const kind = KINDS.has((l as ViewLine).kind) ? (l as ViewLine).kind : "text"
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
        lines.push({ kind, text: (l as ViewLine).text.replace(/[\x00-\x1f\x7f]/g, " ").trimEnd() })
      }
      if (!lines.length) continue
      const shown = opts.collapsed
        ? lines.slice(0, 1)
        : lines.length > PANEL_MAX_LINES
          ? [
              ...lines.slice(0, PANEL_MAX_LINES - 1),
              { kind: "muted" as const, text: `… ${lines.length - PANEL_MAX_LINES + 1} more` },
            ]
          : lines
      out.push({ id: panel.id, lines: shown, order, seq })
    }
    out.sort((a, b) => a.order - b.order || a.seq - b.seq)
    return out.map(({ id, lines }) => ({ id, lines }))
  }
}
