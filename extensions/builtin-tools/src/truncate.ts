import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const MAX_OUTPUT_CHARS = 30_000

export interface Truncated {
  text: string
  /** Set when the output was cut; the file holds the full text. */
  fullOutputPath?: string
}

export function toolOutputDir(): string {
  return join(tmpdir(), "amira", "tool-output")
}

/** Keeps the head and tail of oversized output and saves the full text to a temp file. */
export async function truncateOutput(
  text: string,
  label: string,
  max = MAX_OUTPUT_CHARS,
): Promise<Truncated> {
  if (text.length <= max) return { text }
  const dir = toolOutputDir()
  await mkdir(dir, { recursive: true })
  const fullOutputPath = join(dir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  await writeFile(fullOutputPath, text)

  const half = Math.floor(max / 2)
  let head = text.slice(0, half)
  const headCut = head.lastIndexOf("\n")
  if (headCut > half / 2) head = head.slice(0, headCut + 1)
  let tail = text.slice(-half)
  const tailCut = tail.indexOf("\n")
  if (tailCut !== -1 && tailCut < half / 2) tail = tail.slice(tailCut + 1)

  const omitted = text.slice(head.length, text.length - tail.length)
  const lines = omitted.split("\n").length - 1
  const note =
    `\n[... ${omitted.length} characters (${lines} lines) omitted. ` +
    `Full output saved to ${fullOutputPath} — use the read tool with offset/limit to see the rest ...]\n`
  return { text: head + note + tail, fullOutputPath }
}
