import { DEFAULT_TUI_MARGIN, DEFAULT_TUI_MARGIN_ROWS, type TuiSettings } from "@amira/api"
import { type Component, type MouseInput, type RenderContext, truncateToWidth } from "@amira/tui-kit"

/** One content column shared by transcript, chrome and full-screen overlays. */
export function contentGeometry(columns: number, rows: number, settings: TuiSettings, fullscreen: boolean) {
  const configured = settings.margin ?? DEFAULT_TUI_MARGIN
  const left = columns - 2 * configured >= 60 ? configured : Math.max(0, Math.floor((columns - 60) / 2))
  const edgeRows = fullscreen && rows >= 24 ? (settings.marginRows ?? DEFAULT_TUI_MARGIN_ROWS) : 0
  return {
    left,
    width: Math.max(1, columns - 2 * left),
    rows: edgeRows,
    height: Math.max(1, rows - 2 * edgeRows),
  }
}

/** Leave the margins on the terminal's default surface, including committed scrollback. */
export function insetLines(
  lines: string[],
  left: number,
  insets?: readonly (number | undefined)[],
): string[] {
  if (!left && !insets) return lines
  // Pending inline images keep their marker at the very end of the line. Their existing
  // prefix also positions the image and indents every fallback row; don't append spaces.
  return lines.map((line, i) => (line ? " ".repeat(insets?.[i] ?? left) + line : line))
}

/** Move only the outer edge; all inner rendering and width calculations stay content-relative. */
export function marginView(
  content: Component,
  settings: TuiSettings,
  fullscreen: boolean,
  rowInsets?: (lines: string[]) => readonly (number | undefined)[] | undefined,
): Component {
  return {
    render(columns, ctx) {
      const geometry = contentGeometry(columns, ctx.rows, settings, fullscreen)
      const inner = {
        ...ctx,
        rows: geometry.height,
        ...(ctx.commit
          ? {
              commit: ((lines, redraw) =>
                ctx.commit!(
                  insetLines(lines, geometry.left, rowInsets?.(lines)),
                  redraw
                    ? (columns, ctx) => {
                        const next = contentGeometry(columns, ctx.rows, settings, fullscreen)
                        return insetLines(redraw(next.width, { ...ctx, rows: next.height }), next.left)
                      }
                    : undefined,
                )) satisfies NonNullable<RenderContext["commit"]>,
            }
          : {}),
        ...(ctx.place
          ? {
              place: (p: Parameters<NonNullable<typeof ctx.place>>[0]) =>
                ctx.place!({ ...p, col: p.col + geometry.left, row: p.row + geometry.rows }),
            }
          : {}),
      }
      const rendered = content.render(geometry.width, inner)
      const insets = rowInsets?.(rendered)
      const lines = insetLines(
        rendered.map((line, i) =>
          truncateToWidth(line, Math.max(1, geometry.width + geometry.left - (insets?.[i] ?? geometry.left))),
        ),
        geometry.left,
        insets,
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
  const x = event.x - geometry.left
  const y = event.y - geometry.rows
  if (event.action === "press" && (x < 0 || x >= geometry.width || y < 0 || y >= geometry.height))
    return undefined
  return { ...event, x, y }
}
