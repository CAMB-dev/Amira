import { themeToken, truncateToWidth, visibleWidth, wrapText } from "@amira/tui-kit"
import { type Block, type BlockEnv, LinesBlock } from "../blocks/base.ts"
import { bandRows, timestampRoom, timestampRow } from "../format.ts"
import { glyphs } from "../glyphs.ts"
import type { PaneRow } from "../transcript-pane.ts"

/** The prompt of the turn at the viewport's top, only after its real first row scrolled away. */
export function stickyPrompt(blocks: readonly Block[], layout: readonly PaneRow[]): LinesBlock | undefined {
  const first = layout[0]
  if (!first) return undefined
  for (let i = first.block.index; i >= 0; i--) {
    const block = blocks[i]!
    if (block.kind === "history") return undefined
    if (!(block instanceof LinesBlock) || block.prompt === undefined) continue
    return layout.some((row) => row.block === block && row.line <= block.promptRow) ? undefined : block
  }
  return undefined
}

/** Nonselectable chrome: a single band row, with the original message clock. */
export function stickyPromptLine(block: LinesBlock, env: BlockEnv): string {
  const { theme, width } = env
  const text = block.prompt ?? ""
  const first = text.split(/\r\n?|\n/, 1)[0] ?? ""
  // User rows use wrapText too: it normalizes tabs and discards unsafe terminal controls.
  const preview =
    (wrapText(first, Number.POSITIVE_INFINITY)[0] ?? "") + (first.length < text.length ? glyphs.more : "")
  const head = `  ${theme.accent(glyphs.user)} `
  const bg = themeToken(theme, "userBg")
  const room = Math.max(0, timestampRoom(width, block.timestamp) - visibleWidth(head) - (bg ? 2 : 0))
  const row = timestampRow(head + truncateToWidth(preview, room, glyphs.more), theme, width, block.timestamp)
  return bg ? bandRows([row], width, bg)[0]! : truncateToWidth(row, width, glyphs.more)
}
