import { HitRegions, stripAnsi, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { oneLine } from "./extension-view-rendering.ts"
import { glyphs } from "./glyphs.ts"

export function confirmationText(question: string, yesLabel = "yes", noLabel = "cancels") {
  const prefix = `${oneLine(question)} `
  const yes = `y ${oneLine(yesLabel)}`
  const separator = ` ${glyphs.separator} `
  return {
    text: `${prefix}${yes}${separator}any other key ${oneLine(noLabel)}`,
    yes: visibleWidth(prefix),
    no: visibleWidth(prefix + yes + separator),
  }
}

/** Host prompt targets, only while their footer survived clipping. */
export class ViewPromptHits extends HitRegions {
  prepare(
    rows: string[],
    width: number,
    footer: string,
    confirm?: { yes: number; no: number },
    title?: string,
  ): void {
    this.clear()
    if (!footer || stripAnsi(rows.at(-1) ?? "") !== footer) return
    const y = rows.length - 1
    const add = (id: string, x: number, end: number) =>
      this.add(id, { x, y, width: Math.max(0, Math.min(width, end) - x), height: 1 })
    if (confirm) {
      add("yes", 2 + confirm.yes, 2 + confirm.no - visibleWidth(` ${glyphs.separator} `))
      add("no", 2 + confirm.no, width)
    } else if (title !== undefined) {
      const label = truncateToWidth(`${title} `, Math.max(1, Math.floor((width - 2) / 2)), glyphs.more)
      add("input", 2 + visibleWidth(label), width)
    }
  }
}
