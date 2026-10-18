import { truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { glyphs, viewEllipsis } from "./glyphs.ts"

/** One item of a hint line: "Enter send". Higher `priority` stays longer as the line narrows. */
export interface HintItem {
  text: string
  priority: number
}

/**
 * Joins hint items to fit `width`, dropping whole items, lowest priority first (the later one
 * of equals), rather than cutting one off mid-word. Only a lone item still too wide is cut.
 * `marker` ends that cut; views pass their own so ASCII stays ASCII.
 */
export function fitHint(
  items: (HintItem | false | "" | null | undefined)[],
  width: number,
  separator = ` ${glyphs.separator} `,
  marker = glyphs.more,
): string {
  const kept = items.filter((i): i is HintItem => !!i && i.text !== "")
  const join = () => kept.map((i) => i.text).join(separator)
  while (kept.length > 1 && visibleWidth(join()) > width) {
    let drop = 0
    for (let i = 1; i < kept.length; i++) if (kept[i]!.priority <= kept[drop]!.priority) drop = i
    kept.splice(drop, 1)
  }
  return truncateToWidth(join(), width, marker)
}

/** A view's hints: a lone item still too wide cuts with the view ellipsis, so ASCII stays ASCII. */
export function fitViewHint(
  items: (HintItem | false | "" | null | undefined)[],
  width: number,
  separator = ` ${glyphs.separator} `,
): string {
  return fitHint(items, width, separator, viewEllipsis())
}
