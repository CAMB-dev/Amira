import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { defineTool, type GrepDetails, textResult } from "@amira/api"
import { splitLines } from "./diff.ts"
import { statOrNull, type WalkEntry, walkFiles } from "./files.ts"
import { displayPath, resolvePath } from "./paths.ts"
import { decodeText, looksBinary } from "./text.ts"
import { truncateOutput } from "./truncate.ts"

export const DEFAULT_HEAD_LIMIT = 250
export const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024
const MAX_MATCH_LINE_CHARS = 2000
/** Longer lines are only searched up to here, which bounds the cost of a pathological pattern per line. */
const MAX_TESTED_LINE_CHARS = 10_000

export type GrepOutputMode = "files_with_matches" | "content" | "count"

export interface GrepParams {
  pattern: string
  path?: string
  glob?: string
  ignore_case?: boolean
  output_mode?: GrepOutputMode
  head_limit?: number
}

export const grepTool = defineTool<GrepParams>({
  name: "grep",
  description: [
    "Search file contents with a JavaScript regular expression, line by line.",
    "- `pattern` uses JavaScript RegExp syntax (e.g. `function\\s+\\w+`, `log.*Error`). Escape regex metacharacters to match them literally.",
    "- `path` is a file or directory (default: the working directory). `glob` filters the files of a directory, e.g. `*.ts` or `src/**/*.{ts,tsx}`; a glob without `/` matches file names at any depth.",
    "- `output_mode`: `files_with_matches` (default) lists matching files; `content` shows `file:line:text` for each matching line; `count` shows `file:count`.",
    `- \`head_limit\` caps the number of output lines (default ${DEFAULT_HEAD_LIMIT}).`,
    "- Skips .git, node_modules, binary files and files over 5 MB, and only searches the first 10,000 characters of each line. Paths are relative to the working directory.",
    "- Use glob to find files by name.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression to search for" },
      path: { type: "string", description: "File or directory to search (default: the working directory)" },
      glob: { type: "string", description: "Only search files matching this glob" },
      ignore_case: { type: "boolean", description: "Case-insensitive search (default false)" },
      output_mode: {
        type: "string",
        enum: ["files_with_matches", "content", "count"],
        description: "What to output (default files_with_matches)",
      },
      head_limit: {
        type: "integer",
        minimum: 1,
        description: `Maximum number of output lines (default ${DEFAULT_HEAD_LIMIT})`,
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  concurrency: "parallel",
  async execute(params, ctx) {
    const { pattern, glob, ignore_case } = params
    const mode = params.output_mode ?? "files_with_matches"
    const limit = Math.max(1, Math.floor(params.head_limit ?? DEFAULT_HEAD_LIMIT))
    if (typeof pattern !== "string" || pattern === "") return textResult("pattern is required", true)
    if (!["files_with_matches", "content", "count"].includes(mode)) {
      return textResult(`Unknown output_mode "${mode}"`, true)
    }
    let re: RegExp
    try {
      re = new RegExp(pattern, ignore_case ? "i" : "")
    } catch (err) {
      return textResult(`Invalid regular expression: ${(err as Error).message}`, true)
    }

    const root = resolvePath(ctx.cwd, params.path ?? ".")
    const st = await statOrNull(root)
    if (!st) return textResult(`Path not found: ${root}`, true)
    const files: AsyncIterable<WalkEntry> | WalkEntry[] = st.isDirectory()
      ? walkFiles(root, ctx.signal)
      : [{ abs: root, rel: basename(root) }]
    // A single file named by `path` is searched even if it does not match `glob`.
    const filter = glob && st.isDirectory() ? globFilter(glob) : () => true

    const out: string[] = []
    let total = 0
    let matchedFiles = 0
    let matches = 0
    for await (const f of files) {
      if (ctx.signal.aborted) return textResult("Aborted", true)
      if (!filter(f.rel)) continue
      const text = await readText(f.abs)
      if (text === undefined) continue
      const shown = displayPath(ctx.cwd, f.abs)
      // Numbered as read numbers them: a final line break does not start another line.
      const lines = splitLines(text)
      let count = 0
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!re.test(line.length > MAX_TESTED_LINE_CHARS ? line.slice(0, MAX_TESTED_LINE_CHARS) : line))
          continue
        count++
        if (mode === "files_with_matches") break
        if (mode === "content") {
          total++
          if (out.length < limit) out.push(`${shown}:${i + 1}:${clip(lines[i]!)}`)
        }
      }
      if (count === 0) continue
      matchedFiles++
      matches += count
      if (mode === "content") continue
      total++
      if (out.length < limit) out.push(mode === "count" ? `${shown}:${count}` : shown)
    }

    if (total === 0) return textResult(`No matches for /${pattern}/ in ${displayPath(ctx.cwd, root)}`)
    let text = out.join("\n")
    if (total > out.length) {
      text += `\n\n(Showing ${out.length} of ${total} results. Narrow the search or raise head_limit to see more.)`
    }
    const res = await truncateOutput(text, "grep")
    return {
      content: [{ type: "text", text: res.text }],
      details: {
        mode,
        matchedFiles,
        // files_with_matches stops at a file's first match, so it cannot count them.
        ...(mode === "files_with_matches" ? {} : { matches }),
        total,
        fullOutputPath: res.fullOutputPath,
      } satisfies GrepDetails,
    }
  },
})

function globFilter(pattern: string): (rel: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^(\.\/)+/, "")
  const g = new Bun.Glob(normalized)
  if (normalized.includes("/")) return (rel) => g.match(rel)
  return (rel) => g.match(rel) || g.match(rel.slice(rel.lastIndexOf("/") + 1))
}

async function readText(abs: string): Promise<string | undefined> {
  const st = await statOrNull(abs)
  if (!st || st.size > MAX_GREP_FILE_BYTES) return undefined
  let bytes: Buffer
  try {
    bytes = await readFile(abs)
  } catch {
    return undefined
  }
  // Invalid UTF-8 is searched lossily rather than skipped.
  const decoded = decodeText(bytes)
  return looksBinary(bytes, decoded) ? undefined : decoded.text
}

function clip(line: string): string {
  return line.length > MAX_MATCH_LINE_CHARS
    ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}… [line truncated]`
    : line
}
