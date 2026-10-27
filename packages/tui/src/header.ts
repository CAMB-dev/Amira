import type { ContextWindowSource } from "@amira/ai"
import type { Agent } from "@amira/core"
import { bold, compose, type RenderContext, themeToken, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { CLOCK_INSET, compactTokens } from "./format.ts"
import { glyphs, viewEllipsis } from "./glyphs.ts"
import { displayTitle } from "./title.ts"

/**
 * The context size the header shows. Right after a compaction no reply has told it yet: the
 * compaction's own estimate stands in, rather than 0, until the next reply does.
 */
export function headerContextTokens(
  known: number | undefined,
  agent: Pick<Agent, "messages" | "compactionInfo"> | undefined,
): number | undefined {
  if (known !== undefined || !agent) return known
  for (const m of agent.messages) {
    const after = agent.compactionInfo(m)?.tokensAfter
    if (after !== undefined) return after
  }
  return undefined
}

/** Already-known workspace and session facts: rendering never probes git. */
export interface HeaderInfo {
  cwd: string
  branch?: string
  dirty?: boolean
  title?: string
  cost?: string
  used?: number
  limit?: number
  /** The limit is the built-in default guess, not a known window: it reads "128K?". */
  limitGuessed?: boolean
}

/** The context limit, marked as a guess when the model's window is the built-in default. */
export function headerLimit(
  limit: number,
  model?: { contextWindowSource?: ContextWindowSource },
): Pick<HeaderInfo, "limit" | "limitGuessed"> {
  return { limit, ...(model?.contextWindowSource === "default" ? { limitGuessed: true } : {}) }
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

/**
 * The trailing context survives first; the title is the first leading item to go. The right
 * items end two cells in from the edge, as the left ones start two cells in.
 */
export function headerLine(info: HeaderInfo, frameWidth: number, ctx: RenderContext): string {
  // The same right edge as every transcript clock.
  const inset = frameWidth >= 20 ? CLOCK_INSET : 0
  return headerItems(info, frameWidth - inset, ctx) + " ".repeat(inset)
}

function headerItems(info: HeaderInfo, width: number, ctx: RenderContext): string {
  const { theme } = ctx
  const used = compactTokens(info.used ?? 0).toUpperCase()
  const context =
    contextStyle(ctx, info.used ?? 0, info.limit)(used) +
    (info.limit
      ? theme.muted(` / ${compactTokens(info.limit).toUpperCase()}${info.limitGuessed ? "?" : ""}`)
      : "")
  const cost = info.cost ? theme.muted(info.cost) : ""
  const divider = theme.dim(`  ${glyphs.separator}  `)
  let right = cost ? cost + divider + context : context
  if (visibleWidth(right) > width - 2) right = context
  if (visibleWidth(right) >= width) return truncateToWidth(right, width, viewEllipsis())
  const room = Math.max(0, width - visibleWidth(right) - 3)
  const branch = info.branch
    ? `${theme.muted(`${glyphs.branch} ${info.branch}`)}${info.dirty ? theme.warning("*") : ""}  `
    : ""
  const path = themeToken(theme, "path") ?? theme.fg2
  const cwd = path(info.cwd)
  const title = info.title ? theme.muted(`  ${glyphs.separator}  ${displayTitle(info.title)}`) : ""
  let left = branch + cwd + title
  if (visibleWidth(left) > room) left = branch + cwd
  if (visibleWidth(left) > room) {
    const cwdRoom = room - visibleWidth(branch)
    const tail = info.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? info.cwd
    left =
      cwdRoom >= 4
        ? branch + path(truncateToWidth(`${viewEllipsis()}/${tail}`, cwdRoom, viewEllipsis()))
        : truncateToWidth(branch || cwd, room, viewEllipsis())
  }
  if (visibleWidth(left) === 0) left = ""
  return (
    (left ? `  ${left}` : "") +
    " ".repeat(Math.max(0, width - visibleWidth(left) - (left ? 2 : 0) - visibleWidth(right))) +
    right
  )
}
