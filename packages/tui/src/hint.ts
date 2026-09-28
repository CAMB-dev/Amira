import { truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { Glyphs } from "./glyphs.ts"

/** One item of a hint line: "Enter send". Higher `priority` stays longer as the line narrows. */
export interface HintItem {
  text: string
  priority: number
}

const SEPARATOR = ` ${Glyphs.separator} `

/**
 * Joins hint items to fit `width`, dropping whole items, lowest priority first (the later one
 * of equals), rather than cutting one off mid-word. Only a lone item still too wide is cut.
 */
export function fitHint(items: (HintItem | undefined | false)[], width: number): string {
  const kept = items.filter((i): i is HintItem => !!i && i.text !== "")
  const join = () => kept.map((i) => i.text).join(SEPARATOR)
  while (kept.length > 1 && visibleWidth(join()) > width) {
    let drop = 0
    for (let i = 1; i < kept.length; i++) if (kept[i]!.priority <= kept[drop]!.priority) drop = i
    kept.splice(drop, 1)
  }
  return truncateToWidth(join(), width, Glyphs.ellipsis)
}
