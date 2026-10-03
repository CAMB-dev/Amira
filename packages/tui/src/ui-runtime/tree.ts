import type { UiNode, UiTreeItem, ViewLine, ViewSegment } from "@amira/api"
import { cells } from "./layout.ts"

const EMPTY: string[] = []

export interface TreeDetail {
  height: number
  render(top: number, height: number): string[]
}

export interface TreeRow {
  item: UiTreeItem
  parent: number
  depth: number
  start: number
  detail: string[]
  widget?: TreeDetail
  open: boolean
  last: boolean
  rail: boolean
}

/** Expanded rows only. Reuses row records and the key index across frames; collapsed subtrees are not visited. */
export class TreeIndex {
  rows: TreeRow[] = []
  byKey = new Map<string, number>()
  total = 0
  leadWidth = 0
  #pool: TreeRow[] = []
  #expanded: readonly string[] | undefined
  #open = new Set<string>()

  prepare(
    items: UiTreeItem[],
    expanded: readonly string[] = EMPTY,
    width: number,
    lines: (ls: ViewLine[], w: number) => string[],
    detail?: (node: UiNode, width: number) => TreeDetail,
    segmentWidth: (parts: ViewSegment[]) => number = () => 0,
  ): void {
    this.rows.length = 0
    this.byKey.clear()
    this.total = 0
    this.leadWidth = 0
    // Host interactions replace arrays; setState snapshots them at the public boundary.
    if (expanded !== this.#expanded) {
      this.#expanded = expanded
      this.#open = new Set(expanded)
    }
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
      row.open = this.#open.has(item.key) && expandable(item)
      if (item.lead) this.leadWidth = Math.max(this.leadWidth, segmentWidth(item.lead) + cells(item.gap ?? 1))
      this.rows.push(row)
      this.byKey.set(item.key, index)
      if (row.open && item.children?.length)
        stack.push({ items: item.children, at: 0, parent: index, depth: frame.depth + 1 })
    }
    this.leadWidth = Math.min(this.leadWidth, Math.max(0, width - 6))
    // The lead column is shared by every row, including children without their own lead.
    for (const row of this.rows) {
      row.start = this.total
      row.detail = EMPTY
      row.widget = undefined
      const contentWidth = Math.max(0, width - this.leadWidth - indent(row.depth, width - this.leadWidth) - 4)
      if (row.open && row.item.detail && contentWidth) {
        if (Array.isArray(row.item.detail)) row.detail = lines(row.item.detail, contentWidth)
        else row.widget = detail?.(row.item.detail, contentWidth)
      }
      this.total += 1 + (row.widget?.height ?? row.detail.length) + +!!row.item.underline
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
  const widthLimit = indent(row.depth, width - tree.leadWidth)
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
  !!(
    item.expandable ||
    item.children?.length ||
    (Array.isArray(item.detail) ? item.detail.length : item.detail)
  )
