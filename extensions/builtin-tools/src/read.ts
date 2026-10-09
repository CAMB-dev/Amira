import { readFile } from "node:fs/promises"
import { extname, resolve as resolveFsPath } from "node:path"
import { DEFAULT_SAVE_ABOVE, defineTool, outputSize, type ReadDetails, textResult } from "@amira/api"
import { statOrNull } from "./files.ts"
import { type LineWindow, type ReadLinesResult, readLineWindow } from "./lines.ts"
import { resolvePath } from "./paths.ts"
import { outputLimits } from "./truncate.ts"

export const DEFAULT_READ_LIMIT = 2000
export const DEFAULT_READ_OUTPUT_CHARS = DEFAULT_SAVE_ABOVE - 400
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
  "(Warning: this file is not valid UTF-8, so invalid bytes are shown as U+FFFD. Text editing tools will refuse to change it.)"

export interface ReadParams {
  path: string
  offset?: number
  limit?: number
  force?: boolean
}

export const readTool = defineTool<ReadParams>({
  name: "read",
  description: [
    "Read a local file; path absolute or relative to working directory. Read before editing; parallel reads are fine.",
    `UTF-8/UTF-16(BOM) text: default ${DEFAULT_READ_LIMIT} lines from start, capped near ${DEFAULT_READ_OUTPUT_CHARS.toLocaleString("en-US")} chars (CJK counts as four), stopping at a whole line with continuation offset. Lines truncate at ${MAX_LINE_CHARS} chars.`,
    "Line-number/tab prefixes are not file content: never include them in replacement text or patch context.",
    "PNG/JPEG/GIF/WebP up to 5 MB return visible images. No other binary files or directories; list directories with glob or bash ls.",
    "Unchanged repeat ranges return a reference to the earlier read; force:true returns text.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start reading from" },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum lines (character cap may stop earlier)",
      },
      force: { type: "boolean" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  traits: { readOnly: true, writesFiles: false },
  readKey: ({ path, offset, limit, force }, ctx) => {
    if (typeof path !== "string" || !path || force === true) return undefined
    const abs = resolveFsPath(ctx.cwd, path)
    const file = process.platform === "win32" ? abs.toLowerCase() : abs
    return JSON.stringify(["read/1", file, offset ?? 1, limit ?? null])
  },
  concurrency: "parallel",
  async execute({ path, offset, limit, force }, ctx) {
    if (typeof path !== "string" || path === "") return textResult("path is required", true)
    for (const [name, value] of [
      ["offset", offset],
      ["limit", limit],
    ] as const) {
      if (value !== undefined && !(Number.isInteger(value) && value >= 1)) {
        return textResult(`${name} must be a whole number of at least 1 (got ${String(value)})`, true)
      }
    }
    if (force !== undefined && typeof force !== "boolean") {
      return textResult(`force must be true or false (got ${String(force)})`, true)
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
    // Under the size limit with the notes after it, so the read is never saved as an artifact.
    const shown = formatWindow(abs, window, start, Math.max(1000, outputLimits(ctx).saveAbove - 400))
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
function formatWindow(
  abs: string,
  window: LineWindow,
  start: number,
  budget: number,
): { text: string; lines: number } {
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
    // Measured as the output limits measure: a CJK character counts four.
    const cost = outputSize(row) + 1
    if (out.length > 0 && size + cost > budget) break
    out.push(row)
    size += cost
    last = start + i
  }
  if (last < start - 1 + lines.length || window.more) {
    const of = total === undefined ? "" : ` of ${total}`
    out.push("", `(Showing lines ${start}-${last}${of}. Use offset=${last + 1} to continue reading.)`)
  }
  return { text: out.join("\n"), lines: last - start + 1 }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}
