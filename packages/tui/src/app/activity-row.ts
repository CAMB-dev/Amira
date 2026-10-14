import { bold, type RenderContext, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { compactTokens, formatDuration } from "../format.ts"
import { glyphs } from "../glyphs.ts"
import { markerPrefix } from "../grid.ts"
import { formatElapsed } from "../tool-view.ts"
import { paintShimmer as shimmerLabel } from "./shimmer.ts"

export { shimmerLabel }

export interface ActivityRowInfo {
  label: string
  spinner: string
  stepMs?: number
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
  const prefix = markerPrefix(theme.accent(info.spinner))
  let step =
    info.stepMs === undefined
      ? ""
      : ` ${theme.muted(info.stepMs < 1000 ? formatElapsed(info.stepMs) : formatDuration(info.stepMs))}`
  const stats = [theme.muted(formatElapsed(info.turnMs).replaceAll(" ", ""))]
  if (info.tokens > 0) {
    stats.push(
      theme.dim(glyphs.turnOutput) +
        theme.fg2(
          info.tokens >= 1000 && info.tokens < 1_000_000
            ? `${(info.tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`
            : compactTokens(info.tokens),
        ),
    )
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
  const fullLeft = () => visibleWidth(prefix) + visibleWidth(label + glyphs.more) + visibleWidth(step)
  const fits = () => fullLeft() + visibleWidth(right) + 2 <= width
  // Sacrifice the step clock, then rate/tokens/total time, before shortening the activity.
  if (!fits()) step = ""
  while (!fits() && stats.length) {
    stats.pop()
    right = rightSide()
  }
  right = truncateToWidth(right, Math.max(0, width - 1), glyphs.more)
  const room = Math.max(0, width - visibleWidth(right) - 2)
  const labelRoom = Math.max(0, room - visibleWidth(prefix) - visibleWidth(step))
  const endingWidth = visibleWidth(glyphs.more)
  const shown =
    labelRoom >= endingWidth ? truncateToWidth(label, labelRoom - endingWidth, "") + glyphs.more : ""
  info.shimmerVisible?.(shown.length > 0)
  const head = truncateToWidth(prefix, room, "") + shimmerLabel(shown, ctx, info.animationMs) + step
  return `${head}${" ".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(right)))}${right}`
}
