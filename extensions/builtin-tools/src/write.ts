import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { defineTool, textResult } from "@amira/api"
import { statOrNull } from "./files.ts"
import { displayPath, fileKey, resolvePath } from "./paths.ts"

export interface WriteParams {
  path: string
  content: string
}

export const writeTool = defineTool<WriteParams>({
  name: "write",
  description: [
    "Write a file to the local filesystem, replacing it entirely if it already exists.",
    "- `path` may be absolute or relative to the working directory. Missing parent directories are created.",
    "- Prefer the edit tool for changing existing files; it sends only the changed part.",
    "- Read an existing file before overwriting it so you do not lose content.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path, or path relative to the working directory" },
      content: { type: "string", description: "The full content to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  // Writes to different files run in parallel; writes to the same file keep their order (D71).
  concurrency: "parallel",
  concurrencyKey: (p, ctx) => fileKey(ctx.cwd, p.path),
  async execute({ path, content }, ctx) {
    if (typeof path !== "string" || path === "") return textResult("path is required", true)
    if (typeof content !== "string") return textResult("content must be a string", true)
    if (ctx.signal.aborted) return textResult("Aborted", true)
    const abs = resolvePath(ctx.cwd, path)
    const existing = await statOrNull(abs)
    if (existing?.isDirectory()) return textResult(`${abs} is a directory`, true)
    const blocker = existing ? undefined : await fileAncestor(dirname(abs))
    if (blocker) {
      return textResult(`Cannot create ${abs}: ${blocker} is a file, not a directory`, true)
    }
    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, { signal: ctx.signal })
    } catch (err) {
      return textResult(`Failed to write ${abs}: ${(err as Error).message}`, true)
    }
    const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
    const bytes = Buffer.byteLength(content)
    const verb = existing ? "Overwrote" : "Created"
    return {
      content: [
        { type: "text", text: `${verb} ${displayPath(ctx.cwd, abs)} (${lines} lines, ${bytes} bytes)` },
      ],
      details: { path: abs, created: !existing, lines, bytes },
    }
  },
})

/** The nearest existing ancestor of `dir`, if it is not a directory. */
async function fileAncestor(dir: string): Promise<string | undefined> {
  for (let d = dir; ; d = dirname(d)) {
    const st = await statOrNull(d)
    if (st) return st.isDirectory() ? undefined : d
    if (dirname(d) === d) return undefined
  }
}
