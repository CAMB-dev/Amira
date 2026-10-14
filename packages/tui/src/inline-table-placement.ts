import { MarkdownStream, type MarkdownStreamOptions } from "@amira/tui-kit"

/** Table geometry becomes fixed only once its first rows reach inline scrollback. */
export class InlineTablePlacement {
  private tables = new WeakMap<object, number>()
  private committed = new Map<string, number[]>()
  private live = new Map<string, number>()
  private rows = new WeakMap<string[], (number | undefined)[]>()

  constructor(private currentInset: () => number) {}

  stream(opts: MarkdownStreamOptions): MarkdownStream {
    return new MarkdownStream({
      ...opts,
      onTableRow: (row, table, committing) => this.track(row, table, committing),
      tableWidth: (table, width) => this.width(table, width),
    })
  }

  width(table: object, width: number): number {
    const current = this.currentInset()
    return Math.max(1, width + current - (this.tables.get(table) ?? current))
  }

  track(row: string, table: object, committing: boolean): void {
    const inset = this.tables.get(table) ?? this.currentInset()
    if (committing) {
      this.tables.set(table, inset)
      const insets = this.committed.get(row) ?? []
      insets.push(inset)
      this.committed.set(row, insets)
    } else this.live.set(row, inset)
  }

  beginFrame(): void {
    this.committed.clear()
    this.live.clear()
  }

  attach(lines: string[], source: string[], committing: boolean): string[] {
    this.rows.set(
      lines,
      source.map((row) => (committing ? this.committed.get(row)?.shift() : this.live.get(row))),
    )
    return lines
  }

  prepend(lines: string[], source: string[], before = lines.length - source.length): string[] {
    this.rows.set(lines, [...Array<undefined>(before).fill(undefined), ...(this.rows.get(source) ?? [])])
    return lines
  }

  insets(lines: string[]): readonly (number | undefined)[] | undefined {
    return this.rows.get(lines)
  }
}
