import { bold, type RenderContext, Spinner, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { compactTokens, formatDuration } from "../format.ts"
import { asciiGlyphs, glyphs, viewEllipsis } from "../glyphs.ts"
import { markerPrefix } from "../grid.ts"
import { formatElapsed } from "../tool-view.ts"
import { paintShimmer as shimmerLabel } from "./shimmer.ts"

export { shimmerLabel }

export interface ActivityRowInfo {
  label: string
  spinner: string
  stepMs?: number
  /** False for a label that is not an ongoing activity (a countdown): no ellipsis after it. */
  ongoing?: boolean
  turnMs: number
  tokens: number
  rate: number
  stop: string
  animationMs: number
  shimmerVisible?: (visible: boolean) => void
}

/** One line above the composer; stats give way before the interrupt hint. */
export function activityRow(info: ActivityRowInfo, width: number, ctx: RenderContext): string {
  const { theme } = ctx
  const label = info.label[0]!.toUpperCase() + info.label.slice(1).replace(/[.…]+$/, "")
  const prefix = markerPrefix(theme.accent(Spinner.forGlyphs(info.spinner, ctx.glyphs)))
  let step =
    info.stepMs === undefined
      ? ""
      : // One duration format on the row: past a minute the step reads as the turn ("1m34s").
        ` ${theme.muted((info.stepMs < 1000 ? formatElapsed(info.stepMs) : formatDuration(info.stepMs)).replaceAll(" ", ""))}`
  const stats = [theme.muted(formatElapsed(info.turnMs).replaceAll(" ", ""))]
  if (info.tokens > 0) {
    const count = theme.fg2(
      info.tokens >= 1000 && info.tokens < 1_000_000
        ? `${(info.tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`
        : compactTokens(info.tokens),
    )
    // An ASCII output mark ("v") reads as a version: ASCII names the count instead.
    stats.push(asciiGlyphs() ? count + theme.dim(" out") : theme.dim(glyphs.turnOutput) + count)
  }
  const rate = Math.round(info.rate)
  if (rate > 0) stats.push(theme.fg2(`~${rate} tok/s`))
  const stop =
    ctx.color && info.stop.endsWith(" stop")
      ? bold(theme.fg2(info.stop.slice(0, -5))) + theme.muted(" stop")
      : theme.muted(info.stop)
  const rightSide = () =>
    stats
      .map(
        (text, i) =>
          (i ? (i === 1 && info.tokens > 0 ? "  " : theme.dim(`  ${glyphs.separator}  `)) : "") + text,
      )
      .join("") +
    (stats.length ? "   " : "") +
    stop
  let right = rightSide()
  const ending = info.ongoing === false ? "" : viewEllipsis()
  const fullLeft = () => visibleWidth(prefix) + visibleWidth(label + ending) + visibleWidth(step)
  const fits = () => fullLeft() + visibleWidth(right) + 2 <= width
  // Sacrifice the step clock, then rate/tokens/total time, before shortening the activity.
  if (!fits()) step = ""
  while (!fits() && stats.length) {
    stats.pop()
    right = rightSide()
  }
  right = truncateToWidth(right, Math.max(0, width - 1), viewEllipsis())
  const room = Math.max(0, width - visibleWidth(right) - 2)
  const labelRoom = Math.max(0, room - visibleWidth(prefix) - visibleWidth(step))
  const fitsWhole = visibleWidth(label + ending) <= labelRoom
  const endingWidth = visibleWidth(viewEllipsis())
  const shown = fitsWhole
    ? label + ending
    : labelRoom >= endingWidth
      ? truncateToWidth(label, labelRoom - endingWidth, "") + viewEllipsis()
      : ""
  info.shimmerVisible?.(shown.length > 0)
  const head = truncateToWidth(prefix, room, "") + shimmerLabel(shown, ctx, info.animationMs) + step
  return `${head}${" ".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(right)))}${right}`
}
