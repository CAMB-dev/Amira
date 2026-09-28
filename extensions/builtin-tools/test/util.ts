import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@amira/api"

export function makeCtx(
  cwd: string,
  signal = new AbortController().signal,
): ToolContext & { updates: ToolResult[] } {
  const updates: ToolResult[] = []
  return { cwd, toolCallId: "call-1", signal, updates, update: (p) => void updates.push(p) }
}

export function textOf(r: ToolResult): string {
  return r.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("")
}

/** Creates temp dirs and removes them all in `cleanup`. */
export function tempDirs() {
  const dirs: string[] = []
  return {
    async make(prefix = "amira-tools-"): Promise<string> {
      const d = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(d)
      return d
    },
    async cleanup() {
      for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
    },
  }
}
