import {
  AGENT_STATUS_BADGES,
  type AgentStatusState,
  PANEL_MAX_LINES,
  type PanelDefinition,
  type PanelLine,
  type PanelRenderOptions,
  type ToolLine,
  type ViewSegment,
  type ViewTextTone,
} from "@amira/api"

/** A panel's lines as a frontend draws them: cut to PANEL_MAX_LINES, one row each. */
export interface ResolvedPanel {
  id: string
  lines: PanelLine[]
}

interface Entry {
  panel: PanelDefinition
  order: number
  seq: number
}

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

const TEXT_SEGMENT_KINDS = new Set<ViewTextTone>([
  "text",
  "dim",
  "muted",
  "accent",
  "success",
  "warning",
  "error",
])
const CHIP_TONES = new Set(["neutral", "info", "success", "warning", "danger", "accent"])
const BADGE_STATES = new Set(Object.keys(AGENT_STATUS_BADGES))

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ")

/** Segment parts with a known kind and valid fields; anything else is left out. */
function segments(parts: unknown): ViewSegment[] {
  if (!Array.isArray(parts)) return []
  return parts.flatMap((p): ViewSegment[] => {
    if (!p || typeof p !== "object") return []
    if (p.kind === "spinner") {
      return [{ kind: "spinner", ...(TEXT_SEGMENT_KINDS.has(p.tone) ? { tone: p.tone } : {}) }]
    }
    if (p.kind === "shimmer") {
      if (typeof p.text !== "string") return []
      return [
        {
          kind: "shimmer",
          text: plain(p.text),
          ...(typeof p.startedAt === "number" && Number.isFinite(p.startedAt)
            ? { startedAt: p.startedAt }
            : {}),
          ...(TEXT_SEGMENT_KINDS.has(p.tone) ? { tone: p.tone } : {}),
        },
      ]
    }
    if (p.kind === "badge") {
      if (typeof p.state !== "string" || !BADGE_STATES.has(p.state)) return []
      return [
        {
          kind: "badge",
          state: p.state as AgentStatusState,
          ...(typeof p.label === "string" ? { label: plain(p.label) } : {}),
          ...(p.pad === true ? { pad: true } : {}),
        },
      ]
    }
    if (p.kind === "elapsed") {
      if (typeof p.since !== "number" || !Number.isFinite(p.since)) return []
      return [
        { kind: "elapsed", since: p.since, ...(TEXT_SEGMENT_KINDS.has(p.tone) ? { tone: p.tone } : {}) },
      ]
    }
    if (typeof p.text !== "string") return []
    if (p.kind === "chip") {
      return [{ kind: "chip", text: plain(p.text), ...(CHIP_TONES.has(p.tone) ? { tone: p.tone } : {}) }]
    }
    if (!TEXT_SEGMENT_KINDS.has(p.kind)) return []
    return [{ kind: p.kind, text: plain(p.text) }]
  })
}

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
   * made spaces (in segment parts too), so one bad panel cannot break a frontend. A collapsed
   * panel keeps its first line; a long one is cut to PANEL_MAX_LINES, the last saying how many
   * more there are.
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
      const lines: PanelLine[] = []
      for (const l of raw as unknown[]) {
        if (!l || typeof l !== "object") continue
        if ((l as PanelLine).kind === "segments") {
          const parts = segments((l as { parts?: unknown }).parts)
          if (parts.length) lines.push({ kind: "segments", parts })
          continue
        }
        if (typeof (l as ToolLine).text !== "string") continue
        const kind = KINDS.has((l as ToolLine).kind) ? (l as ToolLine).kind : "text"
        lines.push({ kind, text: plain((l as ToolLine).text).trimEnd() })
      }
      if (!lines.length) continue
      const shown = opts.collapsed
        ? lines.slice(0, 1)
        : lines.length > PANEL_MAX_LINES
          ? [
              ...lines.slice(0, PANEL_MAX_LINES - 1),
              {
                kind: "muted" as const,
                text: `${opts.glyphs?.more ?? "…"} ${lines.length - PANEL_MAX_LINES + 1} more`,
              },
            ]
          : lines
      out.push({ id: panel.id, lines: shown, order, seq })
    }
    out.sort((a, b) => a.order - b.order || a.seq - b.seq)
    return out.map(({ id, lines }) => ({ id, lines }))
  }
}
