import { readFile, writeFile } from "node:fs/promises"
import { defineTool, textResult } from "@amira/api"
import { isBinary, statOrNull } from "./files.ts"
import { displayPath, resolvePath } from "./paths.ts"

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
  concurrency: "serial",
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
    if (isBinary(bytes)) return textResult(`${abs} appears to be a binary file`, true)
    const text = bytes.toString("utf8")

    const crlf = text.includes("\r\n")
    const oldStr = crlf ? toCrlf(old_string) : old_string
    const newStr = crlf ? toCrlf(new_string) : new_string

    const count = countOccurrences(text, oldStr)
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
      await writeFile(abs, updated, { signal: ctx.signal })
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
      details: { path: abs, replacements: n },
    }
  },
})

function toCrlf(s: string): string {
  return s.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")
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
