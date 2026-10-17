import type { RenderContext } from "../component.ts"
import { chromeGlyphs, defaultGlyphs } from "../glyphs.ts"
import { bold } from "../style.ts"
import { truncateToWidth, visibleWidth } from "../width.ts"

/** Draws the card frame in terminal coordinates; scrolling and focus stay with the form. */
export function drawFormCard(
  width: number,
  ctx: RenderContext,
  title: string,
  body: string[],
  footer: string[],
  top: number,
  length: number,
): { output: string[]; left: number; y: number } {
  const { theme } = ctx
  const glyphs = { ...defaultGlyphs, ...ctx.glyphs }
  const chrome = chromeGlyphs(ctx.glyphs)
  const cardWidth = Math.min(width - 8, 88)
  const inner = cardWidth - 2
  const left = Math.floor((width - cardWidth) / 2)
  const edge = (a: string, b: string, text = "") => {
    const label = text ? ` ${truncateToWidth(text, inner - 4, chrome.more)} ` : ""
    return (
      theme.border(a + glyphs.rule) +
      theme.accent(bold(label)) +
      theme.border(glyphs.rule.repeat(Math.max(0, inner - visibleWidth(label) - 1)) + b)
    )
  }
  const more = [top > 0 ? chrome.arrowUp : "", top + body.length < length ? chrome.arrowDown : ""].join("")
  const frame = [
    edge(glyphs.boxTopLeft, glyphs.boxTopRight, title),
    ...[...body, ...footer].map((line) => {
      const fitted = truncateToWidth(line, inner)
      return (
        theme.border(glyphs.codeSide) +
        fitted +
        " ".repeat(Math.max(0, inner - visibleWidth(fitted))) +
        theme.border(glyphs.codeSide)
      )
    }),
    edge(glyphs.boxBottomLeft, glyphs.boxBottomRight, more ? `${more} more` : ""),
  ]
  const y = Math.floor((ctx.rows - frame.length) / 2)
  const output = Array.from({ length: ctx.rows }, (_, row) =>
    row >= y && row < y + frame.length ? " ".repeat(left) + frame[row - y]! : "",
  )
  return { output, left, y }
}
