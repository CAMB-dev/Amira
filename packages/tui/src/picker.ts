import { type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { inputGlyphs } from "./input-glyphs.ts"

/** Rows of items shown at once; the list scrolls to keep the selection visible. */
export const PICKER_ROWS = 8

/** How an item reads in the list. */
export interface PickerRow {
  label: string
  description?: string
}

/**
 * The state of a completion list whose items arrive asynchronously for a key (the text being
 * completed), the part the command popup and the file picker share. A stale answer is dropped.
 * While the items for a new key are on their way, the last list stays drawn (`visible`) so it
 * does not flicker on each key, but keys wait for the fresh list (`open`). Esc dismisses the
 * list until the key changes. It draws nothing about where it sits, so it can live above or
 * below the editor.
 */
export class AsyncList<T> {
  #key: string | undefined
  #result: { key: string; items: T[] } | undefined
  #selected = 0
  #navigated = false
  #dismissed = false
  #generation = 0

  constructor(
    private fetch: (key: string) => Promise<T[]>,
    private onUpdate: () => void,
  ) {}

  /** The text to complete, or undefined when the input is not for this list. */
  update(key: string | undefined): void {
    if (key === this.#key) return
    this.#key = key
    this.#dismissed = false
    const generation = ++this.#generation
    if (key === undefined) {
      this.#result = undefined
      return
    }
    this.fetch(key).then(
      (items) => {
        if (generation !== this.#generation) return
        this.#result = { key, items }
        this.#selected = 0
        this.#navigated = false
        this.onUpdate()
      },
      () => {},
    )
  }

  get key(): string | undefined {
    return this.#key
  }

  /** The items for the current key, once they arrived. */
  get current(): T[] | undefined {
    return this.#key !== undefined && this.#result?.key === this.#key ? this.#result.items : undefined
  }

  /** What to draw: the current items, or the last ones while the next are pending. */
  get shown(): T[] | undefined {
    return this.#key !== undefined ? this.#result?.items : undefined
  }

  /** Whether the list answers keys. */
  get open(): boolean {
    return !this.#dismissed && !!this.current?.length
  }

  /** Whether the list is drawn. */
  get visible(): boolean {
    return !this.#dismissed && !!this.shown?.length
  }

  get selected(): T | undefined {
    return this.current?.[this.#selected]
  }

  /** The user moved the selection, so it wins over what was typed. */
  get navigated(): boolean {
    return this.#navigated
  }

  dismiss(): void {
    this.#dismissed = true
  }

  /** Moves the selection, wrapping around. */
  move(step: -1 | 1): void {
    const n = this.current?.length ?? 0
    if (!n) return
    this.#selected = (this.#selected + step + n) % n
    this.#navigated = true
  }

  /** Rows for the shown items: the selected one marked, descriptions in a column, a counter past a screenful. */
  render(width: number, theme: Theme, row: (item: T) => PickerRow): string[] {
    const items = this.visible ? this.shown : undefined
    if (!items) return []
    return pickerRows(items.map(row), Math.min(this.#selected, items.length - 1), width, theme)
  }
}

/** Draws list rows like the command popup does. */
export function pickerRows(rows: PickerRow[], selected: number, width: number, theme: Theme): string[] {
  const n = rows.length
  const start = Math.min(Math.max(0, selected - PICKER_ROWS + 1), Math.max(0, n - PICKER_ROWS))
  const shown = rows.slice(start, start + PICKER_ROWS)
  const col = Math.min(32, Math.max(...shown.map((r) => visibleWidth(r.label))))
  const lines = shown.map((r, i) => {
    const pad = r.description ? " ".repeat(Math.max(0, col - visibleWidth(r.label))) : ""
    const desc = r.description ? `  ${theme.muted(r.description)}` : ""
    const line =
      start + i === selected
        ? `${theme.accent(inputGlyphs.pointer)} ${theme.accent(r.label)}${pad}${desc}`
        : `  ${r.label}${pad}${desc}`
    return truncateToWidth(line, width, "…")
  })
  if (n > PICKER_ROWS) lines.push(theme.muted(`  ${selected + 1}/${n}`))
  return lines
}
