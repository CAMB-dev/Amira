import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { defineTool, type ReadDetails, textResult } from "@amira/api"
import { statOrNull } from "./files.ts"
import { type LineWindow, type ReadLinesResult, readLineWindow } from "./lines.ts"
import { resolvePath } from "./paths.ts"
import { MAX_OUTPUT_CHARS } from "./truncate.ts"

export const DEFAULT_READ_LIMIT = 2000
export const MAX_LINE_CHARS = 2000
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

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
    "- PNG, JPEG, GIF and WebP images up to 5 MB are returned as images you can see.",
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
    for (const [name, value] of [
      ["offset", offset],
      ["limit", limit],
    ] as const) {
      if (value !== undefined && !(Number.isInteger(value) && value >= 1)) {
        return textResult(`${name} must be a whole number of at least 1 (got ${String(value)})`, true)
      }
    }
    if (ctx.signal.aborted) return textResult("Aborted", true)
    const abs = resolvePath(ctx.cwd, path)
    const st = await statOrNull(abs)
    if (!st) return textResult(`File not found: ${abs}`, true)
    if (st.isDirectory())
      return textResult(`${abs} is a directory, not a file. Use glob or bash to list it.`, true)

    const mimeType = IMAGE_TYPES[extname(abs).toLowerCase()]
    if (mimeType && st.size > MAX_IMAGE_BYTES) {
      return textResult(
        `${abs} is an image of ${formatMb(st.size)}, over the ${formatMb(MAX_IMAGE_BYTES)} limit for images. Resize or compress it first (e.g. with bash).`,
        true,
      )
    }

    if (mimeType) {
      let bytes: Buffer
      try {
        bytes = await readFile(abs, { signal: ctx.signal })
      } catch (err) {
        return textResult(`Failed to read ${abs}: ${(err as Error).message}`, true)
      }
      return {
        content: [{ type: "image", mimeType, data: bytes.toString("base64") }],
        details: { path: abs, mimeType, bytes: bytes.length } satisfies ReadDetails,
      }
    }

    const start = offset ?? 1
    const count = limit ?? DEFAULT_READ_LIMIT
    let window: ReadLinesResult
    try {
      window = await readLineWindow(abs, start, count, MAX_LINE_CHARS + 1, ctx.signal)
    } catch (err) {
      return textResult(`Failed to read ${abs}: ${(err as Error).message}`, true)
    }
    if (window === "aborted") return textResult("Aborted", true)
    if (window === "binary") {
      return textResult(`${abs} appears to be a binary file and cannot be read as text.`, true)
    }
    const shown = formatWindow(abs, window, start)
    let text = shown.text
    if (window.invalidUtf8) text += `\n\n${INVALID_UTF8_WARNING}`
    const details: ReadDetails = {
      path: abs,
      startLine: start,
      lines: shown.lines,
      ...(window.total !== undefined ? { totalLines: window.total } : {}),
    }
    return { content: [{ type: "text", text }], details }
  },
})

/** The numbered lines of a window, and how many lines of the file they show. */
function formatWindow(abs: string, window: LineWindow, start: number): { text: string; lines: number } {
  const { lines, total } = window
  if (total === 0) return { text: `(${abs} is empty)`, lines: 0 }
  if (total !== undefined && start > total) {
    return { text: `(offset ${start} is past the end of ${abs}, which has ${total} lines)`, lines: 0 }
  }

  const out: string[] = []
  let size = 0
  let last = start - 1
  for (const [i, raw] of lines.entries()) {
    const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}… [line truncated]` : raw
    const row = `${String(start + i).padStart(6)}\t${line}`
    // Always return at least one line, even when it alone exceeds the budget.
    if (out.length > 0 && size + row.length + 1 > MAX_OUTPUT_CHARS) break
    out.push(row)
    size += row.length + 1
    last = start + i
  }
  if (last < start - 1 + lines.length || window.more) {
    const of = total === undefined ? "" : ` of ${total}`
    out.push("", `(Showing lines ${start}-${last}${of}. Use offset=${last + 1} to read more.)`)
  }
  return { text: out.join("\n"), lines: last - start + 1 }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}
