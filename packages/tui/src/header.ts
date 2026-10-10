import { bold, compose, type RenderContext, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { compactTokens } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { displayTitle } from "./title.ts"

/** Already-known workspace and session facts: rendering never probes git. */
export interface HeaderInfo {
  cwd: string
  branch?: string
  dirty?: boolean
  title?: string
  cost?: string
  used?: number
  limit?: number
}

/** Context gets progressively louder at 50%, 75%, and 95%. */
export function contextStyle(ctx: RenderContext, used: number, limit?: number) {
  const share = limit ? used / limit : 0
  return share >= 0.95
    ? ctx.theme.error
    : share >= 0.75
      ? compose(bold, ctx.theme.warning)
      : share >= 0.5
        ? ctx.theme.warning
        : ctx.theme.fg2
}

/** The trailing context survives first; the title is the first leading item to go. */
export function headerLine(info: HeaderInfo, width: number, ctx: RenderContext): string {
  const { theme } = ctx
  const used = compactTokens(info.used ?? 0).toUpperCase()
  const context =
    contextStyle(ctx, info.used ?? 0, info.limit)(used) +
    (info.limit ? theme.muted(` / ${compactTokens(info.limit).toUpperCase()}`) : "")
  const cost = info.cost ? theme.muted(info.cost) : ""
  const divider = theme.dim(`  ${glyphs.treePipe}  `)
  let right = cost ? cost + divider + context : context
  if (visibleWidth(right) > width - 2) right = context
  if (visibleWidth(right) >= width) return truncateToWidth(right, width, glyphs.more)
  const room = Math.max(0, width - visibleWidth(right) - 3)
  const branch = info.branch
    ? `${theme.muted(`${glyphs.branch} ${info.branch}`)}${info.dirty ? theme.warning("*") : ""}  `
    : ""
  const cwd = theme.fg2(info.cwd)
  const title = info.title ? theme.muted(`  ${glyphs.separator}  ${displayTitle(info.title)}`) : ""
  let left = branch + cwd + title
  if (visibleWidth(left) > room) left = branch + cwd
  if (visibleWidth(left) > room) {
    const cwdRoom = room - visibleWidth(branch)
    const tail = info.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? info.cwd
    left =
      cwdRoom >= 4
        ? branch + theme.fg2(truncateToWidth(`${glyphs.more}/${tail}`, cwdRoom, glyphs.more))
        : truncateToWidth(branch || cwd, room, glyphs.more)
  }
  return (
    (left ? ` ${left}` : "") +
    " ".repeat(Math.max(0, width - visibleWidth(left) - (left ? 1 : 0) - visibleWidth(right) - 1)) +
    right +
    " "
  )
}
