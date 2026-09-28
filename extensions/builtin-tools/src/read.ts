import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { defineTool, textResult } from "@amira/api"
import { statOrNull } from "./files.ts"
import { resolvePath } from "./paths.ts"
import { decodeText, looksBinary } from "./text.ts"
import { MAX_OUTPUT_CHARS } from "./truncate.ts"

export const DEFAULT_READ_LIMIT = 2000
export const MAX_LINE_CHARS = 2000

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const INVALID_UTF8_WARNING =
  "(Warning: this file is not valid UTF-8, so invalid bytes are shown as U+FFFD. The edit tool will refuse to change it.)"

export interface ReadParams {
  path: string
  offset?: number
  limit?: number
}

export const readTool = defineTool<ReadParams>({
  name: "read",
  description: [
    "Read a file from the local filesystem.",
    "- `path` may be absolute or relative to the working directory.",
    `- By default returns up to ${DEFAULT_READ_LIMIT} lines from the start. For long files, pass \`offset\` (1-based line number to start at) and \`limit\` (number of lines) to read a specific range.`,
    "- Output is numbered like `cat -n`: each line is prefixed with its line number and a tab. The prefix is not part of the file; never include it in `old_string` for the edit tool.",
    `- Lines longer than ${MAX_LINE_CHARS} characters are truncated.`,
    "- UTF-8 and UTF-16 (with BOM) text is supported.",
    "- PNG, JPEG, GIF and WebP images are returned as images you can see.",
    "- Binary files and directories cannot be read; use glob or bash `ls` to list a directory.",
    "- Read a file before editing it. It is fine to read several files in parallel.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path, or path relative to the working directory" },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start reading from" },
      limit: {
        type: "integer",
        minimum: 1,
        description: `Maximum number of lines to read (default ${DEFAULT_READ_LIMIT})`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  concurrency: "parallel",
  async execute({ path, offset, limit }, ctx) {
    if (typeof path !== "string" || path === "") return textResult("path is required", true)
    if (ctx.signal.aborted) return textResult("Aborted", true)
    const abs = resolvePath(ctx.cwd, path)
    const st = await statOrNull(abs)
    if (!st) return textResult(`File not found: ${abs}`, true)
    if (st.isDirectory())
      return textResult(`${abs} is a directory, not a file. Use glob or bash to list it.`, true)

    let bytes: Buffer
    try {
      bytes = await readFile(abs, { signal: ctx.signal })
    } catch (err) {
      return textResult(`Failed to read ${abs}: ${(err as Error).message}`, true)
    }

    const mimeType = IMAGE_TYPES[extname(abs).toLowerCase()]
    if (mimeType) {
      return {
        content: [{ type: "image", mimeType, data: bytes.toString("base64") }],
        details: { path: abs, mimeType, bytes: bytes.length },
      }
    }
    const decoded = decodeText(bytes)
    if (looksBinary(bytes, decoded))
      return textResult(`${abs} appears to be a binary file and cannot be read as text.`, true)

    let text = formatLines(abs, decoded.text, offset ?? 1, limit ?? DEFAULT_READ_LIMIT)
    if (decoded.invalid) text += `\n\n${INVALID_UTF8_WARNING}`
    return textResult(text)
  },
})

function formatLines(abs: string, text: string, offset: number, limit: number): string {
  if (text === "") return `(${abs} is empty)`
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  const start = Math.max(1, Math.floor(offset))
  if (start > lines.length) {
    return `(offset ${start} is past the end of ${abs}, which has ${lines.length} lines)`
  }
  const end = Math.min(lines.length, start - 1 + Math.max(1, Math.floor(limit)))

  const out: string[] = []
  let size = 0
  let last = start - 1
  for (let n = start; n <= end; n++) {
    let line = lines[n - 1]!
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`
    const row = `${String(n).padStart(6)}\t${line}`
    // Always return at least one line, even when it alone exceeds the budget.
    if (out.length > 0 && size + row.length + 1 > MAX_OUTPUT_CHARS) break
    out.push(row)
    size += row.length + 1
    last = n
  }
  if (last < lines.length) {
    out.push("", `(Showing lines ${start}-${last} of ${lines.length}. Use offset=${last + 1} to read more.)`)
  }
  return out.join("\n")
}
