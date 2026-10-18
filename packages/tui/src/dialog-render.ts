import {
  type Editor,
  HitRegions,
  type KeyEvent,
  type LineInput,
  type MouseInput,
  type RenderContext,
  type StyleFn,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { dialogFrame } from "./dialog-frame.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint, type HintItem } from "./hint.ts"

export type DialogHints = ((HintItem & { key?: KeyEvent }) | false | "" | null | undefined)[]

interface Target {
  id: string
  index: number
  column?: number
  row?: number
  key?: KeyEvent
  x?: number
  width?: number
}

/** Targets recorded in body coordinates, then clipped into the rendered frame. */
export class DialogTargets {
  #hits = new HitRegions()
  #rows = new Map<string, Target>()
  #body = new Map<number, Target[]>()
  #options = new Map<number, Target>()
  #width = 0
  #height = 0

  begin(width: number): void {
    this.#hits.clear()
    this.#rows.clear()
    this.#body.clear()
    this.#width = width
    this.#height = 0
  }

  reset(): void {
    this.#hits.reset()
    this.#rows.clear()
  }

  contains(e: MouseInput): boolean {
    return e.x >= 0 && e.x < this.#width && e.y >= 0 && e.y < this.#height
  }

  handle(e: MouseInput): (Target & { double: boolean }) | undefined {
    const hit = this.#hits.handle(e)
    const target = hit && this.#rows.get(hit.id)
    return hit && target ? { ...target, double: hit.double } : undefined
  }

  body(row: number, target: Target): void {
    const targets = this.#body.get(row) ?? []
    targets.push(target)
    this.#body.set(row, targets)
  }

  /** Only complete fitted hints become buttons; dropped or ellipsized labels never do. */
  footer(row: number, items: DialogHints, width: number, theme: Theme): string {
    const text = fitHint(items, width)
    const separator = ` ${glyphs.separator} `
    let from = 0
    for (const item of items) {
      if (!item) continue
      if (!item.text) continue
      const end = from + item.text.length
      if (!text.startsWith(item.text, from) || (end < text.length && !text.startsWith(separator, end)))
        continue
      const at = from
      from = end + separator.length
      if (item.key)
        this.body(row, {
          id: `footer:${item.text}:${item.key.name}:${item.key.ctrl}:${item.key.alt}:${item.key.shift}`,
          index: -1,
          key: item.key,
          x: visibleWidth(text.slice(0, at)),
          width: visibleWidth(item.text),
        })
    }
    return theme.muted(text)
  }

  beginOptions(): void {
    this.#options.clear()
  }

  option(from: number, to: number, target: Target): void {
    for (let y = from; y < to; y++) this.#options.set(y, target)
  }

  placeOptions(offset: number): void {
    this.#body.clear()
    for (const [y, target] of this.#options) this.body(offset + y, target)
  }

  trimBody(cut: number): void {
    this.#body = new Map([...this.#body].filter(([y]) => y >= cut).map(([y, target]) => [y - cut, target]))
  }

  frame(
    title: string,
    body: string[],
    width: number,
    ctx: RenderContext,
    border: StyleFn,
    maxRows: number,
    padded = false,
  ): { rows: string[]; kept: string[] } {
    const room = Math.max(0, maxRows - 2)
    const compact = width < (padded ? 6 : 5) || maxRows < 4
    // Match the frame's clipping, including the one-row fallback which shows only the hint.
    const kept = compact
      ? [title, ...body].slice(-Math.max(1, maxRows))
      : body.length <= room
        ? body
        : [...body.slice(0, room - 1), body.at(-1)!]
    const rows = dialogFrame(title, body, width, ctx, border, maxRows, padded)
    const start = Math.max(0, body.length + 1 - Math.max(1, maxRows))
    // Map body rows through exactly the same clipping as dialogFrame; borders and headings
    // never become targets, even in the bare fallback at very small terminal sizes.
    for (const [y, targets] of this.#body) {
      const shown = compact
        ? y + 1 - start
        : body.length <= room || y < room - 1
          ? y + 1
          : y === body.length - 1
            ? room
            : -1
      if (shown < 0 || shown >= rows.length) continue
      for (const target of targets) {
        const left = compact ? 0 : 1
        const right = compact ? width : width - 1
        const x = target.x === undefined ? left : target.x + (compact ? 0 : 2)
        const end = target.width === undefined ? right : x + target.width
        if (x >= right || end <= left) continue
        this.#rows.set(
          target.id,
          padded && !compact && target.column !== undefined
            ? { ...target, column: target.column + 2 }
            : target,
        )
        this.#hits.add(target.id, {
          x: Math.max(left, x),
          y: shown,
          width: Math.min(right, end) - Math.max(left, x),
          height: 1,
        })
      }
    }
    this.#height = rows.length
    return { rows, kept }
  }
}

/** Render the input viewport and record its local rows before frame clipping. */
export function renderDialogInput(
  width: number,
  ctx: RenderContext,
  {
    budget,
    title,
    targets,
    hints,
    editor,
    secret,
    placeholder = "",
  }: {
    budget: number
    title: string[]
    targets: DialogTargets
    hints: DialogHints
    editor: Editor | undefined
    secret: LineInput | undefined
    placeholder?: string
  },
): string[] {
  editor?.setPrompt(`${glyphs.pointer} `)
  if (editor) editor.maxRows = Number.POSITIVE_INFINITY
  const render = () =>
    secret
      ? [
          `${glyphs.pointer} ${secret.render(Math.max(4, width - 2), ctx.theme, { focused: true, placeholder })}`,
        ]
      : editor!.render(width, ctx)
  let body = render()
  // Give up the blank, then title rows, then scroll the text with the caret in view.
  const blank = title.length + body.length + 2 <= budget ? [""] : []
  const room = Math.max(1, budget - 1 - blank.length)
  if (editor && body.length > room - 1) {
    editor.maxRows = Math.max(1, room - (room > 1 ? 1 : 0))
    body = render()
  }
  const before = fitTitle(title, room - body.length)
  for (let row = 0; row < body.length; row++) {
    targets.body(
      before.length + row,
      secret
        ? { id: "secret", index: -1, column: visibleWidth(`${glyphs.pointer} `) }
        : { id: `editor:${row}`, index: -1, row },
    )
  }
  const out = [...before, ...body, ...blank]
  out.push(targets.footer(out.length, hints, Math.max(1, width - 2), ctx.theme))
  return out
}

/** A wrapped title cut to `rows`, its last row ending in an ellipsis when cut. */
export function fitTitle(title: string[], rows: number): string[] {
  if (rows <= 0) return []
  if (title.length <= rows) return title
  const kept = title.slice(0, Math.max(1, rows))
  kept[kept.length - 1] = `${kept[kept.length - 1]}${glyphs.more}`
  return kept
}

/** Lines cut to `rows` from the end, the last kept one marking the cut. */
export function cutEnd(lines: string[], rows: number, theme: Theme): string[] {
  if (lines.length <= rows) return lines
  if (rows <= 0) return []
  const kept = lines.slice(0, rows)
  kept[rows - 1] = `${kept[rows - 1]}${theme.muted(` ${glyphs.more}`)}`
  return kept
}

/**
 * Lines cut to `rows`: the start and the end, with a marker in the middle saying how many
 * were left out. The start (file names, first hunk) gets the extra row.
 */
export function cutMiddle(lines: string[], rows: number, theme: Theme, width: number): string[] {
  if (lines.length <= rows) return lines
  if (rows <= 0) return []
  if (rows === 2) {
    // Keep both ends even when a standalone omission row would consume the tail.
    const marker = theme.muted(`${glyphs.more} ${lines.length - 2} more lines ${glyphs.more}`)
    const head = truncateToWidth(lines[0]!, Math.max(1, width - visibleWidth(marker) - 1), glyphs.more)
    return [`${head} ${marker}`, lines.at(-1)!]
  }
  const keep = rows - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  const marker = theme.muted(`${glyphs.more} ${lines.length - keep} more lines ${glyphs.more}`)
  return [...lines.slice(0, head), marker, ...lines.slice(lines.length - tail)]
}
