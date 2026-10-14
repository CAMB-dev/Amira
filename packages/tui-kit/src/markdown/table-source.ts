import type { BlockState, LineRender } from "./blocks.ts"

export type Align = "left" | "center" | "right"

export interface Table {
  /** Shared with a candidate header whose rows may already be committed. */
  identity: object
  renderCol: number
  aligns: Align[]
  /** Header first, then the body rows; not the delimiter row. Emptied once frozen. */
  rows: string[][]
  /** The source lines, delimiter row included, for when the table is too wide to lay out. */
  lines: string[]
  /** Set once rows are committed before the table ended: the column widths used, or raw lines. */
  frozen?: number[] | "raw"
}

export interface TableHeader {
  text: string
  renderCol: number
  table?: object
}

const DELIMITER_CELL = /^:?-+:?$/

export function takeHeader(s: BlockState): BlockState["header"] {
  const header = s.header
  s.header = undefined
  return header
}

/**
 * Starts a table whose header was committed as a paragraph, when `line` is its delimiter row.
 * The header shows as its source already, so the table goes on as its source lines.
 */
export function startRawTable(
  s: BlockState,
  header: NonNullable<BlockState["header"]>,
  line: string,
): boolean {
  const aligns = line.includes("|") ? delimiterRow(line) : undefined
  if (!aligns || aligns.length !== splitRow(header.text).length) return false
  s.table = {
    renderCol: header.renderCol,
    identity: header.table ?? aligns,
    aligns,
    rows: [],
    lines: [],
    frozen: "raw",
  }
  s.prevBlank = false
  s.paragraph = false
  return true
}

/**
 * Updates the state after the complete `line`, whose rows were committed in parts as `lr` says
 * rather than by `step`: a paragraph line may have been a table header, or a header's delimiter row.
 */
export function endCut(s: BlockState, line: string, lr: LineRender): void {
  const header = takeHeader(s)
  if (lr.code || !s.paragraph || s.table || !line.includes("|")) return
  if (header && startRawTable(s, header, line)) return
  s.header = { text: line.trimStart(), renderCol: lr.indent, table: lr.table }
}

export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const cells: string[] = []
  let cell = ""
  let ticks = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|"
      i++
    } else if (c === "`") {
      ticks = ticks ? 0 : 1
      cell += c
    } else if (c === "|" && !ticks) {
      cells.push(cell.trim())
      cell = ""
    } else cell += c
  }
  cells.push(cell.trim())
  return cells
}

export function delimiterRow(line: string): Align[] | undefined {
  const cells = splitRow(line)
  if (!cells.every((c) => DELIMITER_CELL.test(c))) return undefined
  return cells.map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
  )
}
