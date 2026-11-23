import { userMessage } from "@amira/ai"
import {
  AGENT_STATUS_BADGES,
  formatElapsed,
  type ToolLine,
  type ViewLine,
  type ViewSegment,
  type ViewTextTone,
} from "@amira/api"
import { type RenderContext, Spinner, type Theme, themeToken, truncateToWidth } from "@amira/tui-kit"
import { hasAnimatedShimmer, paintShimmer } from "./app/shimmer.ts"
import { renderToolLines, terminalText, type ViewMarkers } from "./diff-view.ts"
import { userLines } from "./format.ts"
import { asciiGlyphs, glyphs, viewEllipsis, viewGap, viewSeparator } from "./glyphs.ts"
import { statusBadge } from "./status-badge.ts"
import { animationText, markAnimated } from "./view-animation.ts"

/** Optional live-frame context for declarative animated segments (spinner, shimmer, badge, elapsed). */
export interface SegmentRenderContext {
  spinner?: string
  now?: number
  render?: RenderContext
}

const TEXT_TONES: ReadonlySet<ViewTextTone> = new Set([
  "text",
  "dim",
  "muted",
  "accent",
  "success",
  "warning",
  "error",
])

const resolveTone = (tone: ViewTextTone | undefined, fallback: ViewTextTone): ViewTextTone =>
  tone && TEXT_TONES.has(tone) ? tone : fallback

const CHIP_TOKENS = {
  neutral: "chipNeutral",
  info: "chipInfo",
  success: "chipSuccess",
  warning: "chipWarning",
  danger: "chipDanger",
  accent: "chipAccent",
} as const

/**
 * ASCII chips cannot draw their half-block (or thin-bar) ends, so they keep only the tone as
 * a foreground style, from the same palette role the chip token colors its label with.
 */
const ASCII_CHIP_TOKENS = {
  neutral: "fg2",
  info: "heading1",
  success: "success",
  warning: "warning",
  danger: "error",
  accent: "accent",
} as const

/**
 * Semantic parts share one row; sanitizing each part keeps styling host-owned. Segment text
 * is drawn as given: it often carries user or model content, so the host never rewrites its
 * "·" or "…" (extensions pick separators and cut marks from the glyphs in their render options).
 */
export function segmentText(parts: ViewSegment[], theme: Theme, ctx?: SegmentRenderContext): string {
  const ascii = asciiGlyphs()
  return parts
    .map((part) => {
      if (part.kind === "spinner") {
        const raw = ctx?.spinner ?? new Spinner().glyph
        const glyph = Spinner.forGlyphs(raw, ctx?.render?.glyphs ?? glyphs)
        return theme[resolveTone(part.tone, "accent")](markAnimated(glyph, "spinner"))
      }
      if (part.kind === "shimmer") {
        const safe = terminalText(part.text)
        if (!safe) return ""
        const render = ctx?.render
        if (render && hasAnimatedShimmer(render)) {
          const now = ctx.now ?? Date.now()
          const elapsed =
            part.startedAt !== undefined && Number.isFinite(part.startedAt)
              ? Math.max(0, now - part.startedAt)
              : now
          return markAnimated(paintShimmer(safe, render, elapsed), "shimmer")
        }
        return theme[resolveTone(part.tone, "muted")](safe)
      }
      if (part.kind === "badge") {
        if (!(part.state in AGENT_STATUS_BADGES)) return ""
        const rendered = statusBadge(part.state, ctx?.spinner, { pad: part.pad, label: part.label })[0]
        if (!rendered) return ""
        const safe = terminalText(rendered.text)
        const text = part.state === "working" ? markAnimated(safe, "spinner") : safe
        return theme[resolveTone(rendered.kind, "muted")](text)
      }
      if (part.kind === "elapsed") {
        if (!Number.isFinite(part.since)) return ""
        const now = ctx?.now ?? Date.now()
        const text = formatElapsed(Math.max(0, now - part.since))
        return theme[resolveTone(part.tone, "muted")](markAnimated(text, "elapsed"))
      }
      const text = animationText(part, terminalText(part.text))
      if (part.kind !== "chip") return theme[part.kind](text)
      const tone = part.tone ?? "neutral"
      // Font-limited themes keep label ends inside ASCII, where half blocks and thin bars
      // would need fonts the theme cannot rely on; the bracket keeps the tone's color.
      if (ascii) {
        const style = themeToken(theme, ASCII_CHIP_TOKENS[tone]) ?? theme.text
        return style(`[${text}]`)
      }
      const style = themeToken(theme, CHIP_TOKENS[tone])
      // Mono and older/custom themes have no chip colors; thin bars keep the label distinct.
      return style ? style(text) : `▏${text}▕`
    })
    .join("")
}

/** View cuts and hunk gaps; non-ASCII output keeps the glyphs these views always drew. */
export const viewMarkers = (): ViewMarkers => ({ ellipsis: viewEllipsis(), gap: viewGap() })

/** Tool rows a view draws keep host-composed labels and cuts in the view's glyph set. */
export const viewToolChrome = () => ({
  separator: viewSeparator(),
  ellipsis: viewEllipsis("…"),
  markers: viewMarkers(),
})

/** View lines shared by full-screen views, panels and Markdown renderers. */
export function renderViewLines(
  lines: ViewLine[],
  theme: Theme,
  width: number,
  ctx?: SegmentRenderContext,
): string[] {
  const out: string[] = []
  let plain: ToolLine[] = []
  const flush = () => {
    out.push(...renderToolLines(plain, theme, width, "", undefined, undefined, viewMarkers()))
    plain = []
  }
  for (const line of lines) {
    if (line.kind === "segments") {
      flush()
      out.push(truncateToWidth(segmentText(line.parts, theme, ctx), width, viewEllipsis()))
    } else if (line.kind === "user-message") {
      flush()
      const message = userMessage(line.text.split("\n").map(terminalText).join("\n"))
      if (line.note) message.display = { text: "", note: terminalText(line.note) }
      out.push(...userLines(theme, message, width))
    } else plain.push(line)
  }
  flush()
  return out
}

/** A semantic title is one row, even when its body equivalent would wrap or have a band. */
export function viewTitle(line: ViewLine, theme: Theme, width: number, ctx?: SegmentRenderContext): string {
  if (line.kind === "segments")
    return truncateToWidth(segmentText(line.parts, theme, ctx), width, viewEllipsis())
  if (line.kind === "user-message")
    return truncateToWidth(
      userLines(theme, userMessage(terminalText(line.text)))[0] ?? "",
      width,
      viewEllipsis(),
    )
  if (["text", "muted", "accent", "success", "warning", "error"].includes(line.kind))
    return theme[line.kind]!(truncateToWidth(terminalText(line.text), width, viewEllipsis()))
  return renderToolLines([line], theme, width, "", undefined, undefined, viewMarkers())[0] ?? ""
}
