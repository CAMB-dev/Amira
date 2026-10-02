import {
  PANEL_MAX_LINES,
  type PanelDefinition,
  type PanelRenderOptions,
  type ToolLine,
  type ViewLine,
  type ViewSegment,
} from "@amira/api"

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

const SEGMENT_KINDS = new Set<ViewSegment["kind"]>(["text", "muted", "accent", "success", "warning", "error"])

const KINDS = new Set<ToolLine["kind"]>([
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
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ")
      for (const rawLine of raw as unknown[]) {
        if (!rawLine || typeof rawLine !== "object") continue
        const l = rawLine as { kind?: unknown; text?: unknown; parts?: unknown; note?: unknown }
        if (l.kind === "segments") {
          if (!Array.isArray(l.parts)) continue
          const parts: ViewSegment[] = []
          for (const rawPart of l.parts as unknown[]) {
            if (!rawPart || typeof rawPart !== "object") continue
            const part = rawPart as { kind?: unknown; text?: unknown }
            if (typeof part.text !== "string") continue
            const kind = SEGMENT_KINDS.has(part.kind as ViewSegment["kind"])
              ? (part.kind as ViewSegment["kind"])
              : "text"
            parts.push({ kind, text: clean(part.text) })
          }
          lines.push({ kind: "segments", parts })
          continue
        }
        if (typeof l.text !== "string") continue
        const text = clean(l.text).trimEnd()
        if (l.kind === "user-message") {
          lines.push({
            kind: "user-message",
            text,
            ...(typeof l.note === "string" ? { note: clean(l.note).trimEnd() } : {}),
          })
          continue
        }
        const kind = KINDS.has(l.kind as ToolLine["kind"]) ? (l.kind as ToolLine["kind"]) : "text"
        lines.push({ kind, text })
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
