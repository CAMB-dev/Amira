import { truncateToWidth } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

interface InlineLiveLayout {
  rows: number
  width: number
  /** An answered dialog's echo, not the interactive dialog in the bottom area. */
  dialog?: (width: number) => string[]
  dialogGap: boolean
  /** Only the bottom area's mandatory rows, not its optional activity/status chrome. */
  essentialBottomRows: number
  tools: (max: number) => string[]
}

/** Share the live region between answered echoes, optional tools and the interactive bottom. */
export function inlineLiveLayout(options: InlineLiveLayout) {
  const { rows, width, essentialBottomRows } = options
  const dialog = options.dialog?.(width) ?? []
  const dialogRows = Math.max(1, Math.floor(rows / 4))
  if (dialog.length > dialogRows) {
    dialog.length = dialogRows
    dialog[dialogRows - 1] = truncateToWidth(`${dialog[dialogRows - 1]} ${glyphs.more}`, width, glyphs.more)
  }
  if (dialog.length && options.dialogGap) dialog.unshift("")
  const ordinaryToolRows = Math.max(4, Math.floor(rows / 2))
  // Keep the existing spare row and tool/bottom separator, but reserve dialog essentials
  // before tools. Without an interactive dialog, preserve the normal transcript layout.
  const toolRows = essentialBottomRows
    ? Math.min(ordinaryToolRows, Math.max(0, rows - 2 - dialog.length - essentialBottomRows))
    : ordinaryToolRows
  const drawn = options.tools(toolRows)
  // A single tool's tree or a compaction marker can still exceed the tool renderer's limit.
  // The latest optional rows win over its leading gap; none may consume essential UI rows.
  const tools = essentialBottomRows ? drawn.slice(Math.max(0, drawn.length - toolRows)) : drawn
  const budget = rows - 1 - dialog.length - (tools.length ? tools.length + 1 : 0)
  return { dialog, tools, budget }
}
