import type { StatusItem } from "@amira/api"

export class StatusConflictError extends Error {}

export interface ResolvedStatusItem {
  id: string
  align: "left" | "right"
  tone: NonNullable<StatusItem["tone"]>
  text: string
}

/** Status bar items registered by extensions; frontends call snapshot() when they redraw. */
export class StatusRegistry {
  #items = new Map<string, { item: StatusItem; order: number; seq: number }>()
  #seq = 0

  register(item: StatusItem): () => void {
    if (this.#items.has(item.id))
      throw new StatusConflictError(`status item "${item.id}" is already registered`)
    const entry = { item, order: item.order ?? 0, seq: this.#seq++ }
    this.#items.set(item.id, entry)
    return () => {
      if (this.#items.get(item.id) === entry) this.#items.delete(item.id)
    }
  }

  /** Visible items in display order. A throwing item is skipped rather than breaking the bar. */
  snapshot(): ResolvedStatusItem[] {
    const out: (ResolvedStatusItem & { order: number; seq: number })[] = []
    for (const { item, order, seq } of this.#items.values()) {
      let text: string | undefined
      try {
        text = item.text()
      } catch {
        continue
      }
      if (!text) continue
      out.push({ id: item.id, align: item.align ?? "left", tone: item.tone ?? "default", text, order, seq })
    }
    out.sort((a, b) => a.order - b.order || a.seq - b.seq)
    return out.map(({ id, align, tone, text }) => ({ id, align, tone, text }))
  }
}
