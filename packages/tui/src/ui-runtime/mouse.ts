import { HitRegions, type MouseInput, visibleWidth } from "@amira/tui-kit"
import { inside, type Rect } from "./layout.ts"
import { expandable, treeIndent } from "./tree.ts"
import { buttonLabel, type Plan, tabLabels, type WidgetHost, widgetId } from "./widgets.ts"

export interface WidgetHit {
  plan: Plan
  kind: "focus" | "row" | "disclosure" | "tab" | "input" | "button"
  key?: string
  index?: number
}

/** Targets follow the visible frame, never hidden tabs or display-only tree details. */
export class WidgetHits {
  #regions = new HitRegions()
  #targets = new Map<string, WidgetHit>()
  #rects: Rect[] = []

  reset(): void {
    this.#regions.reset()
    this.#targets.clear()
    this.#rects.length = 0
  }

  prepare(plan: Plan, host: WidgetHost): void {
    this.#regions.clear()
    this.#targets.clear()
    this.#rects.length = 0
    this.#visit(plan, host)
  }

  contains(e: MouseInput): boolean {
    return this.#rects.some((rect) => inside(rect, e.x, e.y))
  }

  handle(e: MouseInput): { target: WidgetHit; x: number; double: boolean } | undefined {
    const hit = this.#regions.handle(e)
    const target = hit && this.#targets.get(hit.id)
    if (hit && target) return { target, x: hit.x, double: hit.double }
  }

  #add(target: WidgetHit, rect: Rect): void {
    if (rect.width <= 0 || rect.height <= 0) return
    const id = JSON.stringify([widgetId(target.plan.node), target.kind, target.key])
    this.#targets.set(id, target)
    this.#regions.add(id, rect)
    this.#rects.push(rect)
  }

  #visit(plan: Plan, host: WidgetHost): void {
    const { node, rect } = plan
    if (!rect.width || !rect.height) return
    const id = widgetId(node)
    if (id !== undefined) {
      const add = (
        kind: WidgetHit["kind"],
        x: number,
        y: number,
        width: number,
        key?: string,
        index?: number,
      ) =>
        this.#add(
          { plan, kind, key, index },
          { x: rect.x + x, y: rect.y + y, width: Math.min(width, rect.width - x), height: 1 },
        )
      if (node.type === "text" || node.type === "tree" || node.type === "table")
        this.#add({ plan, kind: "focus" }, rect)
      if (node.type === "tree") {
        const tree = plan.tree!
        const top = plan.scroll!.top
        for (let i = tree.atOffset(top); i < tree.rows.length; i++) {
          const row = tree.rows[i]!
          const y = row.start - top
          if (y >= rect.height) break
          if (y < 0) continue
          add("row", 0, y, rect.width, row.item.key, i)
          if (expandable(row.item)) {
            const x = 2 + tree.leadWidth + visibleWidth(treeIndent(tree, i, rect.width))
            add("disclosure", x, y, 2, row.item.key, i)
          }
        }
      } else if (node.type === "table") {
        const top = plan.scroll!.top
        for (let y = 1; y < rect.height && top + y - 1 < node.rows.length; y++) {
          const index = top + y - 1
          add("row", 0, y, rect.width, node.rows[index]!.key, index)
        }
      } else if (node.type === "tabs") {
        const { labels, separator, start } = tabLabels(plan, host)
        let x = 2
        for (let i = start; i < labels.length && x < rect.width; i++) {
          const width = visibleWidth(labels[i]!)
          add("tab", x, 0, width - (node.style === "divided" ? 2 : 0), node.tabs[i]!.key)
          x += width + visibleWidth(separator)
        }
      } else if (node.type === "input") add("input", 0, 0, rect.width)
      else if (node.type === "button") add("button", 2, 0, visibleWidth(buttonLabel(node)))
    }
    for (const child of plan.children) this.#visit(child, host)
  }
}
