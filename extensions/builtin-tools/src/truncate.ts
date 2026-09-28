import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const MAX_OUTPUT_CHARS = 30_000
const KEEP_OUTPUT_MS = 24 * 60 * 60 * 1000

export interface Truncated {
  text: string
  /** Set when the output was cut and saved; the file holds the full text. */
  fullOutputPath?: string
}

export function toolOutputDir(): string {
  return join(tmpdir(), "amira", "tool-output")
}

/** Keeps the head and tail of oversized output and saves the full text to a temp file when it can. */
export async function truncateOutput(
  text: string,
  label: string,
  max = MAX_OUTPUT_CHARS,
  dir = toolOutputDir(),
): Promise<Truncated> {
  if (text.length <= max) return { text }
  let fullOutputPath: string | undefined
  let saveError: string | undefined
  try {
    await mkdir(dir, { recursive: true })
    sweepOnce(dir)
    const path = join(dir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
    await writeFile(path, text)
    fullOutputPath = path
  } catch (err) {
    saveError = (err as Error).message
  }

  const half = Math.floor(max / 2)
  let head = text.slice(0, half)
  const headCut = head.lastIndexOf("\n")
  if (headCut > half / 2) head = head.slice(0, headCut + 1)
  let tail = text.slice(-half)
  const tailCut = tail.indexOf("\n")
  if (tailCut !== -1 && tailCut < half / 2) tail = tail.slice(tailCut + 1)

  const omitted = text.slice(head.length, text.length - tail.length)
  const lines = omitted.split("\n").length - 1
  const where = fullOutputPath
    ? `Full output saved to ${fullOutputPath} — use the read tool with offset/limit to see the rest`
    : `The full output could not be saved (${saveError})`
  const note = `\n[... ${omitted.length} characters (${lines} lines) omitted. ${where} ...]\n`
  return { text: head + note + tail, fullOutputPath }
}

const swept = new Set<string>()

/** Deletes saved outputs older than a day, once per directory per process. Best effort, not awaited. */
function sweepOnce(dir: string): void {
  if (swept.has(dir)) return
  swept.add(dir)
  const cutoff = Date.now() - KEEP_OUTPUT_MS
  void (async () => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name)
      try {
        const st = await stat(path)
        if (st.isFile() && st.mtimeMs < cutoff) await rm(path, { force: true })
      } catch {}
    }
  })().catch(() => {})
}
