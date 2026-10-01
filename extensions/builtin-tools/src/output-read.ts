import { readFile } from "node:fs/promises"
import { defineTool, textResult } from "@amira/api"
import { outputLimits, outputStore } from "./truncate.ts"

export const DEFAULT_OUTPUT_READ_LIMIT = 200
const DEFAULT_GREP_LIMIT = 100
const MAX_LINE_CHARS = 2000

export interface OutputReadParams {
  id: string
  offset?: number
  limit?: number
  grep?: string
  ignore_case?: boolean
  column?: number
}

const n = (x: number) => x.toLocaleString("en-US")

/**
 * Reads a saved tool output (an artifact, A1): a range of its lines, or the lines matching a
 * regular expression. The stable way back to output that was too long to return whole, also
 * after it was cleared from the context.
 */
export const outputReadTool = defineTool<OutputReadParams>({
  name: "output_read",
  description: [
    "Read a tool output that was too long to return whole and was saved as an artifact (its id, `a_…`, is in the output's first line).",
    `- Returns numbered lines like read: \`offset\` is the 1-based line to start at, \`limit\` how many lines (default ${DEFAULT_OUTPUT_READ_LIMIT}).`,
    `- \`grep\` returns only the lines matching a JavaScript regular expression (from \`offset\` on, at most \`limit\`, default ${DEFAULT_GREP_LIMIT}), with their line numbers; \`ignore_case\` makes it case-insensitive.`,
    `- Lines longer than ${MAX_LINE_CHARS} characters are cut; \`column\` (1-based) starts every shown line further in, to page through a long line.`,
    "- The artifact is what the tool returned at the time. To see a file as it is now, use read on the file instead.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The artifact id, e.g. a_1f2e3d4c5b" },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start at" },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return" },
      grep: { type: "string", description: "Only return lines matching this JavaScript regular expression" },
      ignore_case: { type: "boolean", description: "Case-insensitive grep (default false)" },
      column: { type: "integer", minimum: 1, description: "1-based character to start each line at" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  concurrency: "parallel",
  async execute({ id, offset, limit, grep, ignore_case, column }, ctx) {
    if (typeof id !== "string" || !id.trim()) return textResult("id is required", true)
    for (const [name, value] of [
      ["offset", offset],
      ["limit", limit],
      ["column", column],
    ] as const) {
      if (value !== undefined && !(Number.isInteger(value) && value >= 1)) {
        return textResult(`${name} must be a whole number of at least 1 (got ${String(value)})`, true)
      }
    }
    let re: RegExp | undefined
    if (grep !== undefined) {
      try {
        re = new RegExp(grep, ignore_case ? "i" : "")
      } catch (err) {
        return textResult(`Invalid regular expression: ${(err as Error).message}`, true)
      }
    }
    const info = outputStore(ctx).find(id.trim())
    if (!info) {
      return textResult(
        `No artifact ${id} in this session. Artifact ids are in the first line of a saved output ("Output saved as artifact a_…").`,
        true,
      )
    }
    if (info.pruned) {
      return textResult(
        `Artifact ${info.id} was deleted with /prune (${info.pruned}); its output is gone.`,
        true,
      )
    }
    let text: string
    try {
      text = await readFile(info.path, "utf8")
    } catch (err) {
      return textResult(
        `Artifact ${info.id} cannot be read (${(err as Error).message}); its file was moved or deleted.`,
        true,
      )
    }
    if (ctx.signal.aborted) return textResult("Aborted", true)

    const lines = text.split("\n")
    if (text.endsWith("\n")) lines.pop()
    const from = offset ?? 1
    const startColumn = (column ?? 1) - 1
    const budget = Math.max(1000, outputLimits(ctx).saveAbove - 600)
    const cut = (line: string) => {
      const l = (line.endsWith("\r") ? line.slice(0, -1) : line).slice(startColumn)
      if (l.length <= MAX_LINE_CHARS) return l
      const next = startColumn + MAX_LINE_CHARS + 1
      return `${l.slice(0, MAX_LINE_CHARS)}… [${n(l.length - MAX_LINE_CHARS)} more characters; column=${next} continues]`
    }
    const facts = [info.tool, `${n(info.lines)} lines`, `${n(info.chars)} characters`]
    if (!info.complete) facts.push(`incomplete: ${info.incomplete ?? "cut short"}`)
    const header = `Artifact ${info.id} (${facts.join(", ")})`
    const out: string[] = []
    let size = 0
    const fits = (row: string) => out.length === 0 || size + row.length + 1 <= budget
    const push = (row: string) => {
      out.push(row)
      size += row.length + 1
    }

    if (re) {
      const max = limit ?? DEFAULT_GREP_LIMIT
      let matches = 0
      let shown = 0
      let last = 0
      for (let i = from - 1; i < lines.length; i++) {
        const line = lines[i]!
        if (!re.test(line)) continue
        matches++
        const row = `${String(i + 1).padStart(6)}\t${cut(line)}`
        if (shown < max && fits(row)) {
          push(row)
          shown++
          last = i + 1
        }
      }
      if (matches === 0) return textResult(`${header}: no lines from line ${from} on match /${grep}/.`)
      const more = matches > shown ? ` Showing the first ${shown}; use offset=${last + 1} to continue.` : ""
      return textResult(
        `${header}, lines matching /${grep}/:\n${out.join("\n")}\n\n(${n(matches)} matching lines.${more})`,
      )
    }

    if (from > lines.length) {
      return textResult(`${header}: offset ${from} is past the end (${n(lines.length)} lines).`, true)
    }
    const count = limit ?? DEFAULT_OUTPUT_READ_LIMIT
    let last = from - 1
    for (let i = from - 1; i < Math.min(lines.length, from - 1 + count); i++) {
      const row = `${String(i + 1).padStart(6)}\t${cut(lines[i]!)}`
      if (!fits(row)) break
      push(row)
      last = i + 1
    }
    const tail =
      last < lines.length
        ? `\n\n(Showing lines ${from}-${last} of ${lines.length}. Use offset=${last + 1} to read more.)`
        : ""
    return textResult(`${header}, lines ${from}-${last}:\n${out.join("\n")}${tail}`)
  },
})
