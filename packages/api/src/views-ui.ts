import type { ViewControl, ViewKeyName, ViewLine, ViewRenderOptions, ViewSegment } from "./views.ts"

/**
 * Experimental (D104 L3): integer terminal cells, a percentage of the space after gaps, or an
 * equal share of remaining space. Omitted sizes mean fill. Negative/nonfinite sizes become 0.
 * Minima are honored when possible; overconstrained children shrink proportionally, with
 * rounding cells assigned in source order. A divider costs one cell in addition to the gap.
 */
export type Size = number | `${number}%` | "fill"

/** Experimental semantic tree row. Keys are stable and unique within their tree. No raw terminal styling. */
export interface UiTreeItem {
  key: string
  row: ViewSegment[]
  aside?: ViewSegment[]
  /** Fixed column before the rail, sized to the widest lead among expanded/visible tree rows. */
  lead?: ViewSegment[]
  /** Replaces the two-cell disclosure/rail slot (e.g. ○ or ◉); navigation still expands/collapses. */
  node?: ViewSegment[]
  /** Thin rule after the row's expanded detail, before children; rail continues through it. */
  underline?: boolean
  /**
   * Shown only while expanded, before children, at the width remaining after the tree indent.
   * Widget details are content-height, display-only: box, row/column, text, progress, bar, rule,
   * table (and blank spacer). IDs/follow are ignored; tree, tabs and input are not rendered.
   */
  detail?: ViewLine[] | UiNode
  children?: UiTreeItem[]
  /** Draw connectors to children and beside details/underlines. lead precedes, node replaces its row slot. */
  rail?: boolean
  /** Show disclosure even before children have loaded; toggle events can load them. */
  expandable?: boolean
}

/**
 * Experimental, frontend-independent view content. All displayed strings are sanitized like
 * ViewLine; segments describe meaning, never colors or escape sequences. IDs must be stable
 * and unique across the view, including inactive tab bodies. Only nonempty visible widgets
 * with IDs participate in Tab order. Give inputs a visible label (e.g. a titled box).
 */
export type UiNode =
  | {
      type: "column" | "row"
      children: { node: UiNode; size?: Size; min?: number }[]
      gap?: number
      divider?: boolean
    }
  | {
      type: "box"
      child: UiNode
      title?: ViewLine | string
      aside?: string
      border?: "round" | "none"
      tone?: "normal" | "accent" | "focus"
    }
  | { type: "text"; id?: string; lines: ViewLine[]; follow?: boolean }
  | {
      type: "tree"
      id: string
      items: UiTreeItem[]
      /** Expands untouched and newly added rows. Explicit expanded state and user toggles win. */
      expanded?: "all"
    }
  | { type: "tabs"; id: string; tabs: { key: string; label: string; body: UiNode }[] }
  | {
      type: "table"
      id?: string
      columns: { key: string; label: string; size?: Size; align?: "left" | "right" }[]
      rows: { key: string; cells: Record<string, string | ViewSegment[]> }[]
    }
  | { type: "bar"; left: ViewSegment[]; right?: ViewSegment[] }
  /** Value is a fraction from 0 to 1, clamped; width is the bar's maximum cell count. */
  | { type: "progress"; value: number; width?: number; label?: string }
  | { type: "rule"; label?: string }
  | { type: "input"; id: string; placeholder?: string; hint?: string }
  /** Blank content; size supplies the default main-axis size inside a row or column. */
  | { type: "spacer"; size?: number }

/**
 * Experimental state owned by the host until the view closes, surviving data replacement and
 * inactive tabs. Maps are keyed by widget ID; selection/expansion/tab values are item keys.
 * Missing selected keys choose the first visible item; missing tabs choose the first tab.
 * Text starts at the top unless follow is true. A following scroll tracks growing content.
 * Treat context state as read-only; use UiControl.setState to override host defaults.
 */
export interface UiState {
  selected: Record<string, string>
  expanded: Record<string, string[]>
  activeTabs: Record<string, string>
  scroll: Record<string, { top: number; following: boolean }>
  inputValues: Record<string, string>
  focused?: string
}

/** Experimental render context for declarative views. */
export interface UiContext extends ViewRenderOptions {
  /** Body rows available after the host's page title, waiting banners and footer. */
  height: number
  state: UiState
}

/** Host updates state before delivering these experimental events. */
export type UiEvent =
  | { type: "select" | "activate"; id: string; key: string }
  | { type: "toggle"; id: string; key: string; expanded: boolean }
  | { type: "tab"; id: string; key: string }
  | { type: "submit"; id: string; value: string }
  /** A key declared in ViewDefinition.keys and not consumed by a focused widget. */
  | { type: "key"; key: ViewKeyName; focused?: string }

/** Experimental event control; existing prompt/confirm overlays retain keyboard ownership. */
export interface UiControl extends ViewControl {
  /** Shallow patch: supplied top-level maps replace those maps, not their individual entries. */
  setState(patch: Partial<UiState>): void
  /** Focus a visible widget by ID; absent/hidden IDs fall back to the first visible widget. */
  focus(id: string): void
}
