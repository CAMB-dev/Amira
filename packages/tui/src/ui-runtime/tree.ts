import type { UiTreeItem, ViewLine } from "@amira/api"

const EMPTY: string[] = []

export interface TreeRow {
  item: UiTreeItem
  parent: number
  depth: number
  start: number
  detail: string[]
  open: boolean
  last: boolean
  rail: boolean
}

/** Expanded rows only. Reuses row records and the key index across frames; collapsed subtrees are not visited. */
export class TreeIndex {
  rows: TreeRow[] = []
  byKey = new Map<string, number>()
  total = 0
  #pool: TreeRow[] = []
  #expanded: readonly string[] | undefined
  #open = new Set<string>()

  prepare(
    items: UiTreeItem[],
    expanded: readonly string[] = EMPTY,
    width: number,
    lines: (ls: ViewLine[], w: number) => string[],
  ): void {
    this.rows.length = 0
    this.byKey.clear()
    this.total = 0
    // Host interactions replace arrays; setState snapshots them at the public boundary.
    // Collapsing an ancestor retains descendants without rescanning that history every frame.
    if (expanded !== this.#expanded) {
      this.#expanded = expanded
      this.#open = new Set(expanded)
    }
    const open = this.#open
    const stack = [{ items, at: 0, parent: -1, depth: 0 }]
    while (stack.length) {
      const frame = stack[stack.length - 1]!
      const item = frame.items[frame.at++]
      if (!item) {
        stack.pop()
        continue
      }
      const index = this.rows.length
      const row = this.#pool[index] ?? {
        item,
        parent: -1,
        depth: 0,
        start: 0,
        detail: [],
        open: false,
        last: false,
        rail: false,
      }
      this.#pool[index] = row
      row.item = item
      row.parent = frame.parent
      row.depth = frame.depth
      row.last = frame.at === frame.items.length
      row.rail = frame.parent >= 0 && !!this.rows[frame.parent]!.item.rail
      row.start = this.total
      row.open = open.has(item.key) && expandable(item)
      row.detail =
        row.open && item.detail?.length
          ? lines(item.detail, Math.max(1, width - indent(frame.depth, width) - 4))
          : EMPTY
      this.rows.push(row)
      this.byKey.set(item.key, index)
      this.total += 1 + row.detail.length
      if (row.open && item.children?.length)
        stack.push({ items: item.children, at: 0, parent: index, depth: frame.depth + 1 })
    }
    this.#pool.length = this.rows.length
  }

  /** Binary search to start painting at the first row intersecting the viewport. */
  atOffset(top: number): number {
    let lo = 0
    let hi = this.rows.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.rows[mid]!.start <= top) lo = mid + 1
      else hi = mid
    }
    return Math.max(0, lo - 1)
  }
}

/** Visible rail columns only; deep indentation never walks an unbounded ancestor chain. */
export function treeIndent(tree: TreeIndex, index: number, width: number, detail = false): string {
  let row = tree.rows[index]!
  const widthLimit = indent(row.depth, width)
  let prefix = ""
  while (row.parent >= 0 && prefix.length < widthLimit) {
    const continuation = prefix.length > 0 || detail
    const branch = !row.rail ? "  " : continuation ? (row.last ? "  " : "│ ") : row.last ? "└─" : "├─"
    prefix = branch + prefix
    row = tree.rows[row.parent]!
  }
  return prefix.slice(Math.max(0, prefix.length - widthLimit))
}

export const indent = (depth: number, width: number): number => Math.min(depth * 2, Math.max(0, width - 6))
export const expandable = (item: UiTreeItem): boolean =>
  !!(item.expandable || item.children?.length || item.detail?.length)
