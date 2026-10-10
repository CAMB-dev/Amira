import { truncateToWidth } from "@amira/tui-kit"
import { LinesBlock, ToolBlock } from "../blocks.ts"
import { glyphs } from "../glyphs.ts"
import type { TranscriptPane } from "../transcript-pane.ts"

/** Transient transcript chrome: never stored, printed on exit, or copied as content. */
export function runningBoundary(pane: TranscriptPane) {
  const rule = new LinesBlock(
    "notice",
    (width, theme) => [truncateToWidth(theme.muted(`  ${glyphs.rule.repeat(3)}`), width)],
    "",
  )
  rule.copyRows = (plain) => plain.map((text) => ({ from: text.length, to: text.length }))
  const clear = () => pane.remove(rule)
  return {
    clear,
    update(calls: readonly ToolBlock[]) {
      const running = calls.find((b) => b.started && !b.end)
      if (!running) return clear()
      const before = pane.blocks
        .slice(0, running.index)
        .filter((b) => b !== rule && (!(b instanceof ToolBlock) || b.started))
        .at(-1)
      if (!before || !["tool", "assistant", "reasoning"].includes(before.kind)) return clear()
      if (rule.index === running.index - 1) return
      clear()
      pane.insertAfter(before, rule)
    },
  }
}
