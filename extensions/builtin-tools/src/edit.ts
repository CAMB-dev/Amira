import { readFile, writeFile } from "node:fs/promises"
import { defineTool, type EditDetails, textResult } from "@amira/api"
import { fileDiff } from "./diff.ts"
import { statOrNull } from "./files.ts"
import { displayPath, fileKey, resolvePath } from "./paths.ts"
import { decodeText, encodeText, looksBinary } from "./text.ts"

export interface EditParams {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const editTool = defineTool<EditParams>({
  name: "edit",
  description: [
    "Replace an exact string in a file.",
    "- `path` may be absolute or relative to the working directory. Read the file first.",
    "- `old_string` must match the file exactly, including whitespace and indentation. Do not include the line-number prefix from read output.",
    "- `old_string` must occur exactly once. If it occurs more than once, include more surrounding lines to make it unique, or set `replace_all` to replace every occurrence (useful for renaming).",
    "- `new_string` must differ from `old_string`. Use the write tool to create new files.",
    "- Files with CRLF line endings keep them; write `\\n` in both strings as usual.",
    "- UTF-8 and UTF-16 files keep their encoding and BOM. Files that are not valid UTF-8 are refused rather than corrupted.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path, or path relative to the working directory" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  // Writes to different files run in parallel; writes to the same file keep their order (D71).
  concurrency: "parallel",
  concurrencyKey: (p, ctx) => fileKey(ctx.cwd, p.path),
  async execute({ path, old_string, new_string, replace_all }, ctx) {
    if (typeof path !== "string" || path === "") return textResult("path is required", true)
    if (typeof old_string !== "string" || typeof new_string !== "string") {
      return textResult("old_string and new_string must be strings", true)
    }
    if (old_string === "")
      return textResult("old_string must not be empty; use the write tool to create files", true)
    if (old_string === new_string)
      return textResult("old_string and new_string are identical; nothing to do", true)
    if (ctx.signal.aborted) return textResult("Aborted", true)

    const abs = resolvePath(ctx.cwd, path)
    const st = await statOrNull(abs)
    if (!st) return textResult(`File not found: ${abs}`, true)
    if (st.isDirectory()) return textResult(`${abs} is a directory`, true)

    let bytes: Buffer
    try {
      bytes = await readFile(abs, { signal: ctx.signal })
    } catch (err) {
      return textResult(`Failed to read ${abs}: ${(err as Error).message}`, true)
    }
    const decoded = decodeText(bytes)
    if (looksBinary(bytes, decoded)) return textResult(`${abs} appears to be a binary file`, true)
    if (decoded.invalid) {
      return textResult(
        `${abs}: file is not valid UTF-8 (invalid byte at offset ${decoded.invalid.offset}; it may use a legacy encoding such as Windows-1252); edit refused to avoid corrupting it. Use bash with a tool that preserves the encoding instead.`,
        true,
      )
    }
    const { text } = decoded

    const { needle: oldStr, count } = findNeedle(text, old_string)
    const newStr = withEol(new_string, eolFor(oldStr, text))
    if (count === 0) {
      return textResult(
        `old_string was not found in ${abs} (0 matches). It must match exactly, including whitespace. Read the file again to check.`,
        true,
      )
    }
    if (count > 1 && !replace_all) {
      return textResult(
        `old_string matches ${count} times in ${abs}. Add surrounding context to make it unique, or set replace_all to replace all ${count}.`,
        true,
      )
    }

    const updated = replace_all ? text.split(oldStr).join(newStr) : spliceFirst(text, oldStr, newStr)
    try {
      await writeFile(abs, encodeText(updated, decoded), { signal: ctx.signal })
    } catch (err) {
      return textResult(`Failed to write ${abs}: ${(err as Error).message}`, true)
    }
    const n = replace_all ? count : 1
    return {
      content: [
        {
          type: "text",
          text: `Edited ${displayPath(ctx.cwd, abs)}: replaced ${n} occurrence${n === 1 ? "" : "s"}`,
        },
      ],
      // The diff is for frontends: details never reach the model, which knows what it changed.
      details: { path: abs, replacements: n, ...fileDiff(text, updated) } satisfies EditDetails,
    }
  },
})

function withEol(s: string, eol: "\n" | "\r\n"): string {
  const lf = s.replaceAll("\r\n", "\n")
  return eol === "\n" ? lf : lf.replaceAll("\n", "\r\n")
}

/** Tries old_string as given, then with CRLF and with LF line endings, so mixed-EOL files still match. */
function findNeedle(text: string, old: string): { needle: string; count: number } {
  for (const needle of new Set([old, withEol(old, "\r\n"), withEol(old, "\n")])) {
    const count = countOccurrences(text, needle)
    if (count > 0) return { needle, count }
  }
  return { needle: old, count: 0 }
}

/** The line ending of the matched text, or the file's most common one when the match has none. */
function eolFor(needle: string, text: string): "\n" | "\r\n" {
  if (needle.includes("\r\n")) return "\r\n"
  if (needle.includes("\n")) return "\n"
  const crlf = text.split("\r\n").length - 1
  const lf = text.split("\n").length - 1 - crlf
  return crlf > lf ? "\r\n" : "\n"
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++
  return count
}

function spliceFirst(text: string, oldStr: string, newStr: string): string {
  const i = text.indexOf(oldStr)
  return text.slice(0, i) + newStr + text.slice(i + oldStr.length)
}
