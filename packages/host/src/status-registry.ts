import type { StatusItem, StatusTone } from "@amira/api"

export class StatusConflictError extends Error {}

export interface ResolvedStatusItem {
  id: string
  align: "left" | "right"
  tone: StatusTone
  /** Higher stays longer when the bar is too narrow (StatusItem.priority). */
  priority: number
  text: string
}

interface Entry {
  item: StatusItem
  order: number
  seq: number
}

const TONES = new Set<string>(["default", "muted", "accent", "success", "warning", "error"])

/**
 * Status bar items registered by extensions; frontends call snapshot() when they redraw.
 * Like tools, an id holds a stack: `override: true` replaces the current item and
 * removing it restores the one below.
 */
export class StatusRegistry {
  #items = new Map<string, Entry[]>()
  #seq = 0

  register(item: StatusItem): () => void {
    const stack = this.#items.get(item.id) ?? []
    if (stack.length && !item.override) {
      throw new StatusConflictError(
        `status item "${item.id}" is already registered; set override: true to replace it`,
      )
    }
    const entry = { item, order: item.order ?? 0, seq: this.#seq++ }
    stack.push(entry)
    this.#items.set(item.id, stack)
    return () => {
      const rest = (this.#items.get(item.id) ?? []).filter((e) => e !== entry)
      if (rest.length) this.#items.set(item.id, rest)
      else this.#items.delete(item.id)
    }
  }

  /**
   * Visible items in display order. Items that throw or return non-strings are skipped,
   * and control characters are stripped, so one bad item cannot break a frontend. A tone
   * function that throws or returns something unknown gives the default tone.
   */
  snapshot(): ResolvedStatusItem[] {
    const out: (ResolvedStatusItem & { order: number; seq: number })[] = []
    for (const stack of this.#items.values()) {
      const { item, order, seq } = stack.at(-1)!
      let raw: unknown
      try {
        raw = item.text()
      } catch {
        continue
      }
      if (typeof raw !== "string") continue
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      const text = raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim()
      if (!text) continue
      const priority = typeof item.priority === "number" && Number.isFinite(item.priority) ? item.priority : 0
      out.push({ id: item.id, align: item.align ?? "left", tone: toneOf(item), priority, text, order, seq })
    }
    out.sort((a, b) => a.order - b.order || a.seq - b.seq)
    return out.map(({ id, align, tone, priority, text }) => ({ id, align, tone, priority, text }))
  }
}

function toneOf(item: StatusItem): StatusTone {
  let tone: unknown = item.tone
  if (typeof tone === "function") {
    try {
      tone = tone()
    } catch {
      tone = undefined
    }
  }
  return typeof tone === "string" && TONES.has(tone) ? (tone as StatusTone) : "default"
}
