import type { UiNode, UiState, ViewLine } from "@amira/api"
import {
  bold,
  inverse,
  type LineInput,
  stripColors,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { terminalText } from "../diff-view.ts"
import { segmentText, viewTitle } from "../view-lines.ts"
import { detailContent } from "./detail.ts"
import { allocate, cells, fit, type Rect, sides } from "./layout.ts"
import { expandable, TreeIndex, treeIndent } from "./tree.ts"

export interface Plan {
  node: UiNode
  rect: Rect
  children: Plan[]
  total: number
  viewport: number
  lines?: string[]
  tree?: TreeIndex
  columns?: number[]
  border?: boolean
  scroll?: { top: number; following: boolean }
}

export interface WidgetHost {
  state: UiState
  changed(): void
  theme: Theme
  inputs: Map<string, LineInput>
  trees: Map<string, TreeIndex>
  expand(node: Extract<UiNode, { type: "tree" }>): void
  anonymousScroll: Map<string, { top: number; following: boolean }>
  scrollables: Plan[]
  lines(lines: ViewLine[], width: number): string[]
  input(id: string): LineInput
  cursor: boolean
}

export const widgetId = (node: UiNode): string | undefined => ("id" in node ? node.id : undefined)
export const scrollable = (node: UiNode): boolean =>
  node.type === "text" || node.type === "tree" || node.type === "table"

/** Reconcile and lay out once. Only active tab bodies and nonempty rectangles are visited. */
export function prepare(
  node: UiNode,
  rect: Rect,
  host: WidgetHost,
  widgets: Plan[],
  path = "root",
  displayOnly = false,
): Plan {
  const plan: Plan = { node, rect, children: [], total: 0, viewport: rect.height }
  if (!rect.width || !rect.height) return plan
  const id = widgetId(node)
  if (id !== undefined) widgets.push(plan)
  const child = (n: UiNode, r: Rect, key = String(plan.children.length)) =>
    plan.children.push(prepare(n, r, host, widgets, `${path}/${key}`, displayOnly))
  switch (node.type) {
    case "column":
    case "row": {
      const horizontal = node.type === "row"
      const length = horizontal ? rect.width : rect.height
      const requests = node.children.map((c) => ({
        ...c,
        size: c.size ?? (c.node.type === "spacer" ? c.node.size : undefined),
      }))
      const sizes = allocate(length, requests, node.gap, node.divider)
      let at = 0
      node.children.forEach((c, i) => {
        const size = Math.min(sizes[i]!, Math.max(0, length - at))
        child(
          c.node,
          horizontal ? { ...rect, x: rect.x + at, width: size } : { ...rect, y: rect.y + at, height: size },
        )
        at += size + cells(node.gap ?? 0) + (node.divider ? 1 : 0)
      })
      break
    }
    case "box": {
      plan.border = node.border !== "none" && rect.width >= 8 && rect.height >= 3
      const inset = plan.border ? 1 : 0
      child(node.child, {
        x: rect.x + inset,
        y: rect.y + inset,
        width: rect.width - 2 * inset,
        height: rect.height - 2 * inset,
      })
      break
    }
    case "tabs": {
      const active = node.tabs.find((t) => t.key === host.state.activeTabs[node.id]) ?? node.tabs[0]
      if (active) {
        reconcile(host.state.activeTabs, node.id, active.key, host)
        child(active.body, { ...rect, y: rect.y + 1, height: rect.height - 1 }, active.key)
      } else reconcile(host.state.activeTabs, node.id, undefined, host)
      break
    }
    case "tree": {
      host.expand(node)
      let tree = host.trees.get(node.id)
      if (!tree) {
        tree = new TreeIndex()
        host.trees.set(node.id, tree)
      }
      tree.prepare(
        node.items,
        host.state.expanded[node.id],
        rect.width,
        host.lines,
        (node, width) => {
          const content = detailContent(node, width, host.lines)
          return {
            height: content.height,
            render: (top, height) => {
              const detail = prepare(
                content.node,
                { x: 0, y: 0, width, height: content.height },
                host,
                [],
                "detail",
                true,
              )
              return paint(detail, host, top, height)
            },
          }
        },
        (parts) => visibleWidth(segmentText(parts, host.theme)),
      )
      plan.tree = tree
      plan.total = tree.total
      const selected = host.state.selected[node.id]
      if (selected === undefined || !tree.byKey.has(selected))
        reconcile(host.state.selected, node.id, tree.rows[0]?.item.key, host)
      break
    }
    case "table": {
      plan.columns = allocate(Math.max(0, rect.width - (id !== undefined ? 2 : 0)), node.columns, 1)
      plan.total = node.rows.length
      plan.viewport = Math.max(0, rect.height - 1)
      if (id !== undefined && !node.rows.some((r) => r.key === host.state.selected[id]))
        reconcile(host.state.selected, id, node.rows[0]?.key, host)
      break
    }
    case "text":
      plan.lines = host.lines(node.lines, Math.max(1, rect.width - (id !== undefined ? 2 : 0)))
      plan.total = plan.lines.length
      break
    case "input":
      host.input(node.id)
      break
  }
  if (scrollable(node) && !displayOnly) {
    const max = Math.max(0, plan.total - plan.viewport)
    const scroll = (id !== undefined ? host.state.scroll[id] : host.anonymousScroll.get(path)) ?? {
      top: 0,
      following: node.type === "text" && !!node.follow,
    }
    const top = scroll.following ? max : Math.min(cells(scroll.top), max)
    if (id !== undefined && (!host.state.scroll[id] || scroll.top !== top)) host.changed()
    scroll.top = top
    if (id !== undefined) host.state.scroll[id] = scroll
    else host.anonymousScroll.set(path, scroll)
    plan.scroll = scroll
    host.scrollables.push(plan)
  }
  return plan
}

function reconcile(
  map: Record<string, string>,
  id: string,
  value: string | undefined,
  host: WidgetHost,
): void {
  if (map[id] === value) return
  if (value === undefined) delete map[id]
  else map[id] = value
  host.changed()
}

/** Paint only viewport rows for trees/tables; layouts compose already-clipped child rectangles. */
export function paint(plan: Plan, host: WidgetHost, from = 0, height = plan.rect.height): string[] {
  const { node, rect } = plan
  const w = rect.width
  const h = Math.max(0, Math.min(height, rect.height - from))
  if (!w || !h) return []
  const { theme, state } = host
  const id = widgetId(node)
  const focused = id !== undefined && state.focused === id
  const top = plan.scroll?.top ?? 0
  const marker = focused ? theme.accent("❯ ") : "  "
  let out: string[] = []
  if (from > 0 && ["bar", "progress", "rule", "input", "spacer"].includes(node.type))
    return Array<string>(h).fill(" ".repeat(w))
  switch (node.type) {
    case "column":
    case "row": {
      const horizontal = node.type === "row"
      out = Array<string>(h).fill("")
      for (const [i, c] of plan.children.entries()) {
        const start = horizontal ? c.rect.x - rect.x : c.rect.y - rect.y
        if (horizontal) {
          if (start >= w) break
          const lines = paint(c, host, from, h)
          for (let y = 0; y < h; y++) {
            let between = " ".repeat(Math.max(0, start - visibleWidth(out[y]!)))
            if (node.divider && i > 0 && between.length) between = theme.border("│") + between.slice(1)
            out[y] += between + (lines[y] ?? " ".repeat(c.rect.width))
          }
        } else {
          const divider = start - cells(node.gap ?? 0) - 1 - from
          if (node.divider && i > 0 && divider >= 0 && divider < h) out[divider] = theme.border("─".repeat(w))
          const begin = Math.max(from, start)
          const end = Math.min(from + h, start + c.rect.height)
          if (end <= begin) continue
          const lines = paint(c, host, begin - start, end - begin)
          for (let y = 0; y < lines.length; y++) out[begin - from + y] = lines[y]!
        }
      }
      break
    }
    case "box": {
      const inset = plan.border ? 1 : 0
      const begin = Math.max(from, inset)
      const end = Math.min(from + h, rect.height - inset)
      out = plan.children[0] && end > begin ? paint(plan.children[0], host, begin - inset, end - begin) : []
      if (plan.border) {
        const color = node.tone === "accent" || node.tone === "focus" ? theme.accent : theme.border
        const title =
          node.title === undefined
            ? ""
            : typeof node.title === "string"
              ? terminalText(node.title)
              : viewTitle(node.title, theme, w - 2)
        const strong = node.tone === "focus"
        const rule = strong ? "━" : "─"
        const aside = node.aside ? truncateToWidth(` ${terminalText(node.aside)} `, w - 2, "…") : ""
        const label = title
          ? truncateToWidth(` ${title} `, Math.max(0, w - 2 - visibleWidth(aside)), "…")
          : ""
        const head =
          label + color(rule.repeat(Math.max(0, w - 2 - visibleWidth(label) - visibleWidth(aside)))) + aside
        out = out.map((s) => color(strong ? "┃" : "│") + s + color(strong ? "┃" : "│"))
        if (from === 0) out.unshift(color(strong ? "┏" : "╭") + head + color(strong ? "┓" : "╮"))
        if (from + h === rect.height)
          out.push(color((strong ? "┗" : "╰") + rule.repeat(w - 2) + (strong ? "┛" : "╯")))
      }
      break
    }
    case "tree": {
      const tree = plan.tree!
      const offset = top + from
      for (let i = tree.atOffset(offset); i < tree.rows.length && out.length < h; i++) {
        const row = tree.rows[i]!
        const pad = treeIndent(tree, i, w)
        if (row.start >= offset) {
          const selected = state.selected[node.id] === row.item.key
          const marker = selected ? (focused ? "❯ " : "› ") : focused && out.length === 0 ? "» " : "  "
          const lead = fit(segmentText(row.item.lead ?? [], theme), tree.leadWidth)
          const disclosure = row.item.node
            ? fit(segmentText(row.item.node, theme), 2)
            : expandable(row.item)
              ? row.open
                ? "▾ "
                : "▸ "
              : row.item.rail
                ? "│ "
                : "  "
          const left = marker + lead + pad + disclosure + segmentText(row.item.row, theme)
          const line = sides(left, segmentText(row.item.aside ?? [], theme), w)
          out.push(selected ? (theme.selection?.(line) ?? line) : line)
        }
        const prefix = () =>
          `${focused && out.length === 0 ? "» " : "  "}${" ".repeat(tree.leadWidth)}${treeIndent(tree, i, w, true)}${row.item.rail ? "│ " : "  "}`
        const start = Math.max(0, offset - row.start - 1)
        const count = Math.min(h - out.length, (row.widget?.height ?? row.detail.length) - start)
        if (count > 0) {
          const lines = row.widget ? row.widget.render(start, count) : row.detail.slice(start, start + count)
          for (const line of lines) out.push(prefix() + line)
        }
        const underline = row.start + 1 + (row.widget?.height ?? row.detail.length)
        if (row.item.underline && underline >= offset && out.length < h) {
          const pad = prefix()
          out.push(pad + theme.border("─".repeat(Math.max(0, w - visibleWidth(pad)))))
        }
      }
      if (!out.length && focused) out.push(marker)
      break
    }
    case "tabs": {
      const divided = node.style === "divided"
      const accent = divided ? theme.accent(" ") : ""
      const color = accent !== stripColors(accent)
      const labels = node.tabs.map((t) => {
        const label = terminalText(t.label)
        const selected = t.key === state.activeTabs[node.id]
        const text = selected
          ? divided && color
            ? bold(inverse(theme.accent(label)))
            : theme.accent(`[${label}]`)
          : theme.muted(label)
        return text + (divided ? "  " : "")
      })
      const separator = divided ? `${theme.border("│")}  ` : "  "
      const gap = divided ? 3 : 2
      const active = Math.max(
        0,
        node.tabs.findIndex((t) => t.key === state.activeTabs[node.id]),
      )
      let start = active
      let used = visibleWidth(labels[active] ?? "")
      while (start > 0 && used + visibleWidth(labels[start - 1]!) + gap <= w - 2) {
        used += visibleWidth(labels[--start]!) + gap
      }
      out.push(marker + labels.slice(start).join(separator))
      if (plan.children[0]) out.push(...paint(plan.children[0], host))
      break
    }
    case "table": {
      const row = (values: string[]) =>
        values.map((v, i) => fit(v, plan.columns![i]!, node.columns[i]!.align === "right")).join(" ")
      if (from === 0)
        out.push(
          (id !== undefined ? marker : "") + theme.muted(row(node.columns.map((c) => terminalText(c.label)))),
        )
      for (let i = top + Math.max(0, from - 1); i < node.rows.length && out.length < h; i++) {
        const r = node.rows[i]!
        const selected = id !== undefined && state.selected[id] === r.key
        const lead = id === undefined ? "" : selected ? (focused ? "❯ " : "› ") : "  "
        const text =
          lead +
          row(
            node.columns.map((c) => {
              const value = Object.hasOwn(r.cells, c.key) ? (r.cells[c.key] ?? "") : ""
              return typeof value === "string" ? terminalText(value) : segmentText(value, theme)
            }),
          )
        out.push(selected ? (theme.selection?.(text) ?? text) : text)
      }
      break
    }
    case "text":
      out = plan
        .lines!.slice(top + from, top + from + h)
        .map((s, i) => (id !== undefined ? (i === 0 ? marker : "  ") : "") + s)
      if (!out.length && focused) out.push(marker)
      break
    case "bar":
      out.push(sides(segmentText(node.left, theme), segmentText(node.right ?? [], theme), w))
      break
    case "progress": {
      const value = Number.isFinite(node.value) ? Math.max(0, Math.min(1, node.value)) : 0
      const label = terminalText(node.label ?? `${Math.round(value * 100)}%`)
      const size = Math.min(cells(node.width ?? 20), Math.max(0, w - visibleWidth(label) - 1))
      const done = Math.round(value * size)
      out.push(
        theme.success("━".repeat(done)) + theme.muted("─".repeat(size - done)) + (size ? " " : "") + label,
      )
      break
    }
    case "rule": {
      const label = node.label ? ` ${terminalText(node.label)} ` : ""
      out.push(theme.border(label + "─".repeat(Math.max(0, w - visibleWidth(label)))))
      break
    }
    case "input": {
      const hint = terminalText(node.hint ?? "")
      const room = Math.max(1, w - 2 - Math.min(visibleWidth(hint) + 1, Math.floor(w / 3)))
      const input = host.input(node.id).render(room, theme, {
        focused: focused && host.cursor && w > 2,
        placeholder: terminalText(
          [node.placeholder, !focused && node.activate !== undefined ? `(${node.activate} to type)` : ""]
            .filter(Boolean)
            .join(" "),
        ),
      })
      out.push(marker + fit(input, room) + (hint ? ` ${theme.muted(hint)}` : ""))
      break
    }
    case "spacer":
      break
  }
  out = out.slice(0, h).map((s) => fit(s, w))
  while (out.length < h) out.push(" ".repeat(w))
  return out
}
