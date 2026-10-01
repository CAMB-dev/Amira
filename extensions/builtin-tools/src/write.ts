import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { defineTool, textResult, type WriteDetails } from "@amira/api"
import { fileDiff } from "./diff.ts"
import { statOrNull } from "./files.ts"
import { mutateFiles } from "./mutation.ts"
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
    "- Prefer an available patch or replacement tool for changing existing files; it sends only the changed part.",
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
  traits: { writesFiles: "paths", usesMutationHook: true },
  getWrittenPaths: ({ path }) => (typeof path === "string" && path ? [path] : []),
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
    const before = existing ? await previousText(abs, existing.size) : ""
    try {
      await mutateFiles(ctx, [{ path: abs, after: Buffer.from(content) }], async () => {
        ctx.signal.throwIfAborted()
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content, { signal: ctx.signal })
      })
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
      details: {
        path: abs,
        created: !existing,
        lines,
        bytes,
        ...(before === undefined
          ? { hunks: [], added: lines, removed: 0, truncated: true }
          : fileDiff(before, content)),
      } satisfies WriteDetails,
    }
  },
})

/** Files up to this size are diffed against what they held before a write. */
const MAX_DIFF_BYTES = 1024 * 1024

/** What a file held before it is overwritten, for the diff; undefined when too large or unreadable. */
async function previousText(abs: string, size: number): Promise<string | undefined> {
  if (size > MAX_DIFF_BYTES) return undefined
  try {
    return (await readFile(abs)).toString("utf8")
  } catch {
    return undefined
  }
}

/** The nearest existing ancestor of `dir`, if it is not a directory. */
async function fileAncestor(dir: string): Promise<string | undefined> {
  for (let d = dir; ; d = dirname(d)) {
    const st = await statOrNull(d)
    if (st) return st.isDirectory() ? undefined : d
    if (dirname(d) === d) return undefined
  }
}
