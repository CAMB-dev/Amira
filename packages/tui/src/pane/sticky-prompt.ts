import { themeToken, truncateToWidth, visibleWidth, wrapText } from "@amira/tui-kit"
import { type Block, type BlockEnv, LinesBlock } from "../blocks/base.ts"
import { bandRows, timestampRoom, timestampRow, userBandPaddingIn } from "../format.ts"
import { glyphs, viewEllipsis } from "../glyphs.ts"
import type { PaneRow } from "../transcript-pane.ts"

/** The prompt whose real band has reached the viewport's top edge. */
export function stickyPrompt(blocks: readonly Block[], layout: readonly PaneRow[]): LinesBlock | undefined {
  const first = layout[0]
  if (!first) return undefined
  for (let i = first.block.index; i >= 0; i--) {
    const block = blocks[i]!
    if (block === first.block && first.line < 0) continue
    if (block.kind === "history") return undefined
    if (block instanceof LinesBlock && block.prompt !== undefined) return block
  }
  return undefined
}

/** Below twelve available transcript rows, keep the compact one-row preview. */
const MIN_BAND_ROWS = 12

/** Nonselectable chrome: the real band's ANSI rows, capped at three text rows. */
export function stickyPromptLines(block: LinesBlock, env: BlockEnv, transcriptRows: number): string[] {
  if (transcriptRows < MIN_BAND_ROWS) return [stickyPromptLine(block, env)]
  const real = block.lines(env)
  const padding = userBandPaddingIn(real)
  const end = Math.min(real.length - padding, padding + 3)
  // A truncated band must not replace the next real text row with synthetic bottom padding.
  return real.length - 2 * padding > 3 ? real.slice(0, end) : real
}

/** The next real user/history band pushes this band's upper rows offscreen. */
export function stickyPromptOverlay(
  blocks: readonly Block[],
  layout: readonly PaneRow[],
  env: BlockEnv,
  height: number,
): { block: LinesBlock | undefined; lines: string[] } {
  // The last transcript row must remain content, including find/selection and mouse targets.
  if (height <= 1) return { block: undefined, lines: [] }
  const block = stickyPrompt(blocks, layout)
  if (!block) return { block, lines: [] }
  // A compact preview is different from the real band: do not paint it above (or
  // instead of) the first actual text row while that row is still entering the viewport.
  const first = layout[0]!
  // At natural entry the real band owns its find/selection decoration, not sticky chrome.
  if (first.block === block && first.line === 0) return { block, lines: [] }
  if (height < MIN_BAND_ROWS && first.block === block && first.line <= userBandPaddingIn(block.lines(env)))
    return { block, lines: [] }
  const lines = stickyPromptLines(block, env, height)
  const next = layout.findIndex(
    (row) =>
      row.block.index > block.index &&
      row.line === 0 &&
      (row.block.kind === "history" || (row.block instanceof LinesBlock && row.block.prompt !== undefined)),
  )
  return { block, lines: next < 0 ? lines : lines.slice(Math.max(0, lines.length - next)) }
}

/** Compact fallback: a single band row, with the original message clock. */
export function stickyPromptLine(block: LinesBlock, env: BlockEnv): string {
  const { theme, width } = env
  const text = block.prompt ?? ""
  const first = text.split(/\r\n?|\n/, 1)[0] ?? ""
  // User rows use wrapText too: it normalizes tabs and discards unsafe terminal controls.
  const preview =
    (wrapText(first, Number.POSITIVE_INFINITY)[0] ?? "") + (first.length < text.length ? viewEllipsis() : "")
  const head = `${theme.accent(glyphs.user)} `
  const bg = themeToken(theme, "userBg")
  const room = Math.max(0, timestampRoom(width, block.timestamp) - visibleWidth(head))
  const clockTheme =
    bg && bg(" ") !== " " ? { ...theme, muted: themeToken(theme, "surfaceMuted") ?? theme.muted } : theme
  const row = timestampRow(
    head + truncateToWidth(preview, room, viewEllipsis()),
    clockTheme,
    width,
    block.timestamp,
  )
  return bg ? bandRows([row], width, bg)[0]! : truncateToWidth(row, width, viewEllipsis())
}
