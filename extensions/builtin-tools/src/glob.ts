import { statSync } from "node:fs"
import path from "node:path"
import { defineTool, textResult } from "@amira/api"
import { statOrNull, walkFiles } from "./files.ts"
import { displayPath, resolvePath } from "./paths.ts"
import { truncateOutput } from "./truncate.ts"

export const GLOB_LIMIT = 1000

export interface GlobParams {
  pattern: string
  path?: string
}

export const globTool = defineTool<GlobParams>({
  name: "glob",
  description: [
    'Find files by name with a glob pattern such as "**/*.ts" or "src/**/test_*.py".',
    "- The pattern is matched against paths relative to `path` (default: the working directory). Use `**/` to match at any depth; `*.ts` alone only matches the top level.",
    "- Supports `*`, `**`, `?`, `[abc]` and `{a,b}`. A pattern may also start with an absolute directory or `../`, which then becomes the search root.",
    `- Returns matching file paths, newest modification time first, at most ${GLOB_LIMIT}.`,
    "- .git and node_modules are skipped. Use grep to search file contents.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search in (default: the working directory)" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  concurrency: "parallel",
  async execute({ pattern, path }, ctx) {
    if (typeof pattern !== "string" || pattern === "") return textResult("pattern is required", true)
    const split = splitGlob(resolvePath(ctx.cwd, path ?? "."), pattern)
    const root = split.root
    const st = await statOrNull(root)
    if (!st) return textResult(`Directory not found: ${root}`, true)
    if (!st.isDirectory()) return textResult(`${root} is not a directory`, true)

    const glob = new Bun.Glob(split.pattern)
    const matches: { abs: string; mtime: number }[] = []
    for await (const e of walkFiles(root, ctx.signal)) {
      if (!glob.match(e.rel)) continue
      matches.push({ abs: e.abs, mtime: (await statOrNull(e.abs))?.mtimeMs ?? 0 })
    }
    if (ctx.signal.aborted) return textResult("Aborted", true)
    if (matches.length === 0) {
      return textResult(`No files matched "${pattern}" in ${displayPath(ctx.cwd, root)}`)
    }

    matches.sort((a, b) => b.mtime - a.mtime)
    const shown = matches.slice(0, GLOB_LIMIT).map((m) => displayPath(ctx.cwd, m.abs))
    let text = shown.join("\n")
    if (matches.length > GLOB_LIMIT) {
      text += `\n\n(Showing the ${GLOB_LIMIT} most recently modified of ${matches.length} matches. Use a more specific pattern or path.)`
    }
    const out = await truncateOutput(text, "glob")
    return {
      content: [{ type: "text", text: out.text }],
      details: { count: matches.length, fullOutputPath: out.fullOutputPath },
    }
  },
})

/**
 * Drops leading `./` and moves a leading absolute, `~` or `../` directory into the search root, since
 * patterns are matched against paths relative to the root.
 */
export function splitGlob(root: string, pattern: string): { root: string; pattern: string } {
  let p = pattern.replaceAll("\\", "/")
  while (p.startsWith("./")) p = p.slice(2)
  if (!/^([a-zA-Z]:)?\/|^~|^\.\.(\/|$)/.test(p)) return { root, pattern: p }
  // Without wildcards it is just a path: list that directory, or match that one file.
  if (!/[*?[\]{}]/.test(p)) {
    const abs = resolvePath(root, p)
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) return { root: abs, pattern: "*" }
    return { root: path.dirname(abs), pattern: path.basename(abs) }
  }
  const segs = p.split("/")
  let i = 0
  while (i < segs.length - 1 && !/[*?[\]{}]/.test(segs[i]!)) i++
  let base = segs.slice(0, i).join("/") || "/"
  if (/^[a-zA-Z]:$/.test(base)) base += "/"
  return { root: resolvePath(root, base), pattern: segs.slice(i).join("/") }
}
