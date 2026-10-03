import type { UiEvent, UiNode, UiState, ViewKeyName, ViewLine } from "@amira/api"
import { type InputEvent, isSubmitKey, LineInput, type Theme } from "@amira/tui-kit"
import { terminalText } from "../diff-view.ts"
import { cells, inside } from "./layout.ts"
import { expandable, type TreeIndex } from "./tree.ts"
import { type Plan, paint, prepare, scrollable, type WidgetHost, widgetId } from "./widgets.ts"

const map = <T>(): Record<string, T> => Object.create(null)
const initialState = (): UiState => ({
  selected: map(),
  expanded: map(),
  activeTabs: map(),
  scroll: map(),
  inputValues: map(),
})

/** Host-local experimental widget state. No timers, terminal ownership, extension imports or dashboard knowledge. */
export class UiRuntime {
  state = initialState()
  /** Whether preparation repaired state that the extension used to build this frame. */
  reconciled = false
  #inputs = new Map<string, LineInput>()
  #trees = new Map<string, TreeIndex>()
  #widgets: Plan[] = []
  #scrollables: Plan[] = []
  #anonymousScroll = new Map<string, { top: number; following: boolean }>()
  #frame: { node: UiNode; width: number; height: number; host: WidgetHost } | undefined
  #dirty = true

  constructor(private emit: (event: UiEvent) => void) {}

  setState(patch: Partial<UiState>): void {
    for (const key of ["selected", "expanded", "activeTabs", "scroll", "inputValues"] as const) {
      if (patch[key] !== undefined)
        Object.assign(this.state, { [key]: Object.assign(Object.create(null), patch[key]) })
    }
    if (patch.expanded) {
      for (const [id, keys] of Object.entries(patch.expanded)) this.state.expanded[id] = [...keys]
    }
    if (Object.hasOwn(patch, "focused")) this.state.focused = patch.focused
    this.#dirty = true
  }

  focus(id: string): void {
    this.state.focused = id
    this.#dirty = true
  }

  /** A failed extension render must not leave invisible widgets accepting input. */
  clearFrame(): void {
    this.#widgets.length = 0
    this.#scrollables.length = 0
    this.#frame = undefined
  }

  dispose(): void {
    this.state = initialState()
    this.#inputs.clear()
    this.#trees.clear()
    this.#anonymousScroll.clear()
    this.#scrollables.length = 0
    this.#widgets.length = 0
    this.#frame = undefined
  }

  render(
    node: UiNode,
    width: number,
    height: number,
    theme: Theme,
    lines: (ls: ViewLine[], w: number) => string[],
    cursor = true,
  ): string[] {
    this.reconciled = false
    const host: WidgetHost = {
      state: this.state,
      changed: () => {
        this.reconciled = true
      },
      theme,
      lines,
      cursor,
      inputs: this.#inputs,
      trees: this.#trees,
      scrollables: this.#scrollables,
      anonymousScroll: this.#anonymousScroll,
      input: (id) => this.#input(id),
    }
    this.#frame = { node, width: cells(width), height: cells(height), host }
    const plan = this.#prepare()!
    return paint(plan, host)
  }

  #prepare(): Plan | undefined {
    if (!this.#frame) return
    const { node, width, height, host } = this.#frame
    this.#widgets.length = 0
    this.#scrollables.length = 0
    const plan = prepare(node, { x: 0, y: 0, width, height }, host, this.#widgets)
    if (!this.#widgets.some((p) => widgetId(p.node) === this.state.focused)) {
      const focused = widgetId(this.#widgets[0]?.node ?? { type: "spacer" })
      if (focused !== this.state.focused) this.reconciled = true
      this.state.focused = focused
    }
    this.#dirty = false
    return plan
  }

  #input(id: string): LineInput {
    let input = this.#inputs.get(id)
    if (!input) {
      input = new LineInput()
      this.#inputs.set(id, input)
    }
    const value = terminalText(this.state.inputValues[id] ?? "")
    // Replacing on every render would reset the caret and horizontal scroll.
    if (value !== input.value) input.value = value
    if (this.state.inputValues[id] !== input.value) this.reconciled = true
    this.state.inputValues[id] = input.value
    return input
  }

  /** Whether the focused widget is a text input, which owns printable keys such as q. */
  get typing(): boolean {
    if (this.#dirty) this.#prepare()
    return this.#widgets.some((p) => p.node.type === "input" && widgetId(p.node) === this.state.focused)
  }

  /** The viewer matches declared shortcuts only after host/widget key handling. */
  key(key: ViewKeyName): void {
    this.#event({ type: "key", key, focused: this.state.focused })
  }

  handleInput(e: InputEvent): boolean {
    if (this.#dirty) this.#prepare()
    if (e.type === "mouse") {
      if (e.action !== "wheel" || (e.button !== "up" && e.button !== "down")) return false
      const target = this.#scrollables.findLast((p) => inside(p.rect, e.x, e.y))
      if (!target) return false
      this.#scroll(target, e.button === "up" ? -3 : 3)
      return true
    }
    if (e.type === "key" && e.name === "tab" && !e.ctrl && !e.alt) {
      const n = this.#widgets.length
      if (!n) return false
      const at = this.#widgets.findIndex((p) => widgetId(p.node) === this.state.focused)
      this.state.focused = widgetId(this.#widgets[(at + (e.shift ? n - 1 : 1)) % n]!.node)
      return true
    }
    const plan = this.#widgets.find((p) => widgetId(p.node) === this.state.focused)
    if (!plan) return false
    const node = plan.node
    const id = widgetId(node)!
    if (node.type === "input") {
      const input = this.#input(id)
      if (isSubmitKey(e)) {
        this.#event({ type: "submit", id, value: input.value })
        return true
      }
      const safe =
        e.type === "paste"
          ? { ...e, text: terminalText(e.text) }
          : e.type === "key" && e.text !== undefined
            ? { ...e, text: terminalText(e.text) }
            : e
      const handled = input.handleInput(safe)
      this.state.inputValues[id] = input.value
      return handled
    }
    if (e.type !== "key" || e.ctrl || e.alt || e.shift) return false
    if (node.type === "tabs" && (e.name === "left" || e.name === "right")) {
      const n = node.tabs.length
      if (n) {
        const at = node.tabs.findIndex((t) => t.key === this.state.activeTabs[id])
        const key = node.tabs[(at + (e.name === "left" ? n - 1 : 1)) % n]!.key
        this.state.activeTabs[id] = key
        this.#event({ type: "tab", id, key })
      }
      return true
    }
    if (node.type === "tree" || node.type === "table") {
      const selected = this.state.selected[id]
      const index =
        node.type === "tree"
          ? (plan.tree!.byKey.get(selected ?? "") ?? 0)
          : Math.max(
              0,
              node.rows.findIndex((r) => r.key === selected),
            )
      if (e.name === "enter") {
        if (selected !== undefined) this.#event({ type: "activate", id, key: selected })
        return true
      }
      if (e.name === "up" || e.name === "down") {
        const total = node.type === "tree" ? plan.tree!.rows.length : node.rows.length
        const next = Math.max(0, Math.min(total - 1, index + (e.name === "up" ? -1 : 1)))
        this.#select(plan, next)
        return true
      }
      if (node.type === "tree" && (e.name === "left" || e.name === "right")) {
        const row = plan.tree!.rows[index]
        if (!row) return true
        if (e.name === "left" && !row.open) {
          if (row.parent >= 0) this.#select(plan, row.parent)
        } else if (expandable(row.item)) {
          const open = e.name === "right"
          if (open !== row.open) {
            const expanded = new Set(this.state.expanded[id])
            if (open) expanded.add(row.item.key)
            else expanded.delete(row.item.key)
            this.state.expanded[id] = [...expanded]
            this.#event({ type: "toggle", id, key: row.item.key, expanded: open })
          }
        }
        return true
      }
    }
    if (scrollable(node)) {
      if (e.name === "pageup" || e.name === "pagedown") {
        this.#scroll(plan, Math.max(1, plan.viewport) * (e.name === "pageup" ? -1 : 1))
        return true
      }
      if (e.name === "home" || e.name === "end") {
        Object.assign(plan.scroll!, {
          top: e.name === "home" ? 0 : Math.max(0, plan.total - plan.viewport),
          following: e.name === "end",
        })
        return true
      }
      if (node.type === "text" && (e.name === "up" || e.name === "down")) {
        this.#scroll(plan, e.name === "up" ? -1 : 1)
        return true
      }
    }
    return false
  }

  #select(plan: Plan, index: number): void {
    const node = plan.node
    if (node.type !== "tree" && node.type !== "table") return
    const row = plan.tree?.rows[index]
    const key = node.type === "tree" ? row?.item.key : node.rows[index]?.key
    if (key === undefined) return
    this.state.selected[node.id!] = key
    const position = row?.start ?? index
    const scroll = this.state.scroll[node.id!]!
    if (position < scroll.top) scroll.top = position
    else if (position >= scroll.top + plan.viewport) scroll.top = Math.max(0, position - plan.viewport + 1)
    scroll.following = false
    this.#event({ type: "select", id: node.id!, key })
  }

  #scroll(plan: Plan, by: number): void {
    const scroll = plan.scroll!
    const max = Math.max(0, plan.total - plan.viewport)
    scroll.top = Math.max(0, Math.min(max, scroll.top + by))
    scroll.following = by > 0 && scroll.top === max
  }

  #event(e: UiEvent): void {
    this.#dirty = true
    this.emit(e)
  }
}
