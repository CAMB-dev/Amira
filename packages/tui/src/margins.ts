import { DEFAULT_TUI_MARGIN, DEFAULT_TUI_MARGIN_ROWS, type TuiSettings } from "@amira/api"
import { type Component, type MouseInput, translateMouse, truncateToWidth } from "@amira/tui-kit"

/** Default cap on ultrawide terminals so prose stays comfortable to scan. */
export const MAX_READING_WIDTH = 136

/** One content column shared by transcript, chrome and full-screen overlays. */
export function contentGeometry(columns: number, rows: number, settings: TuiSettings) {
  const configured = settings.margin ?? DEFAULT_TUI_MARGIN
  let left = columns - 2 * configured >= 60 ? configured : Math.max(0, Math.floor((columns - 60) / 2))
  if (settings.margin === undefined && columns - 2 * left > MAX_READING_WIDTH) {
    left = Math.floor((columns - MAX_READING_WIDTH) / 2)
  }
  const edgeRows = rows >= 24 ? (settings.marginRows ?? DEFAULT_TUI_MARGIN_ROWS) : 0
  return {
    left,
    width: Math.max(1, columns - 2 * left),
    rows: edgeRows,
    height: Math.max(1, rows - 2 * edgeRows),
  }
}

/** Leave the margins on the terminal's default surface, including the exit printout. */
export function insetLines(lines: string[], left: number): string[] {
  if (!left) return lines
  return lines.map((line) => (line ? " ".repeat(left) + line : line))
}

/** Move only the outer edge; all inner rendering and width calculations stay content-relative. */
export function marginView(content: Component, settings: TuiSettings): Component {
  return {
    render(columns, ctx) {
      const geometry = contentGeometry(columns, ctx.rows, settings)
      const inner = {
        ...ctx,
        rows: geometry.height,
        ...(ctx.place
          ? {
              place: (p: Parameters<NonNullable<typeof ctx.place>>[0]) =>
                ctx.place!({ ...p, col: p.col + geometry.left, row: p.row + geometry.rows }),
            }
          : {}),
      }
      const rendered = content.render(geometry.width, inner)
      const lines = insetLines(
        rendered.map((line) => truncateToWidth(line, geometry.width)),
        geometry.left,
      )
      if (!geometry.rows) return lines
      return [
        ...Array<string>(geometry.rows).fill(""),
        ...lines.slice(0, geometry.height),
        ...Array<string>(Math.max(0, geometry.height - lines.length) + geometry.rows).fill(""),
      ]
    },
  }
}

/** Full-screen viewers use content coordinates too; outside presses must not activate widgets. */
export function contentMouse(
  event: MouseInput,
  geometry: ReturnType<typeof contentGeometry>,
): MouseInput | undefined {
  const translated = translateMouse(event, geometry.left, geometry.rows)
  const { x, y } = translated
  if (event.action === "press" && (x < 0 || x >= geometry.width || y < 0 || y >= geometry.height))
    return undefined
  return translated
}
