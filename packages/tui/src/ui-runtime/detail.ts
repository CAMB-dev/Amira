import type { UiNode, ViewLine } from "@amira/api"
import { allocate, cells } from "./layout.ts"

export interface DetailContent {
  node: UiNode
  height: number
}

/** Content-sized display-only subtree. No IDs, state, focus targets or nested interactive widgets. */
export function detailContent(
  node: UiNode,
  width: number,
  lines: (ls: ViewLine[], w: number) => string[],
): DetailContent {
  if (width <= 0) return { node: { type: "spacer" }, height: 0 }
  switch (node.type) {
    case "column":
    case "row": {
      const horizontal = node.type === "row"
      const requests = node.children.map((c) => ({
        ...c,
        size: c.size ?? (c.node.type === "spacer" ? c.node.size : undefined),
      }))
      const sizes = horizontal ? allocate(width, requests, node.gap, node.divider) : []
      const children = requests.map((c, i) => {
        const content =
          horizontal && c.node.type === "spacer"
            ? { node: c.node, height: 0 }
            : detailContent(c.node, horizontal ? sizes[i]! : width, lines)
        // With no vertical viewport budget, fill/percentage heights use content height.
        const height = horizontal
          ? content.height
          : Math.max(cells(c.min ?? 0), typeof c.size === "number" ? cells(c.size) : content.height)
        return { ...content, height, size: horizontal ? c.size : height, min: c.min }
      })
      const gap = cells(node.gap ?? 0) + +!!node.divider
      return {
        node: { ...node, children: children.map(({ node, size, min }) => ({ node, size, min })) },
        height: horizontal
          ? Math.max(0, ...children.map((c) => c.height))
          : children.reduce((sum, c) => sum + c.height, 0) + Math.max(0, children.length - 1) * gap,
      }
    }
    case "box": {
      const inset = node.border !== "none" && width >= 8 ? 1 : 0
      const child = detailContent(node.child, width - 2 * inset, lines)
      return {
        node: { ...node, child: child.node },
        height: inset ? Math.max(1, child.height) + 2 : child.height,
      }
    }
    case "text":
      return { node: { type: "text", lines: node.lines }, height: lines(node.lines, width).length }
    case "table":
      return { node: { ...node, id: undefined }, height: node.rows.length + 1 }
    case "bar":
    case "progress":
    case "rule":
      return { node, height: 1 }
    case "spacer":
      return { node, height: cells(node.size ?? 0) }
    default:
      return { node: { type: "spacer" }, height: 0 }
  }
}
