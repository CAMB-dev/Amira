import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { amiraHome, projectKey } from "@amira/core"
import { defaultPasteLabel, type Editor, type EditorPart } from "@amira/tui-kit"

/** Entries kept per project. */
export const HISTORY_LIMIT = 1000
/** Entries bigger than this (expanded) are remembered for the session but not written to disk. */
const MAX_SAVED_CHARS = 256 * 1024

export interface HistoryEntry {
  parts: EditorPart[]
  /** The full text, folded pastes expanded; entries are unique by it. */
  text: string
  /** The text with folded pastes as placeholders, for searching and showing. */
  display: string
}

export interface PromptHistoryOptions {
  /** A JSONL file to load and append to. Without it the history lives in memory only. */
  file?: string
  limit?: number
}

function entry(parts: EditorPart[]): HistoryEntry {
  let n = 0
  const text = parts.map((p) => (typeof p === "string" ? p : p.paste)).join("")
  const display = parts
    .map((p) => {
      if (typeof p === "string") return p
      const lines = p.paste.replace(/\n$/, "").split("\n").length
      return defaultPasteLabel({ lines, chars: p.paste.length, n: ++n })
    })
    .join("")
  return { parts, text, display }
}

/** Parses one line of the history file; undefined for anything malformed. */
function parseLine(line: string): EditorPart[] | undefined {
  try {
    const v = JSON.parse(line) as { text?: unknown; parts?: unknown }
    if (typeof v.text === "string") return [v.text]
    if (!Array.isArray(v.parts)) return undefined
    const parts: EditorPart[] = []
    for (const p of v.parts) {
      if (typeof p === "string") parts.push(p)
      else if (p && typeof p === "object" && typeof (p as { paste?: unknown }).paste === "string")
        parts.push({ paste: (p as { paste: string }).paste })
      else return undefined
    }
    return parts
  } catch {
    return undefined
  }
}

function serialize(e: HistoryEntry): string {
  const plain = e.parts.every((p) => typeof p === "string")
  return JSON.stringify(plain ? { text: e.text } : { parts: e.parts })
}

/**
 * The prompts sent in a project, oldest first: unique (sending one again moves it to the end)
 * and capped. Persisted as JSONL, one `{"text"}` or `{"parts"}` object per line; the file is
 * appended to and rewritten without duplicates once it grows to twice the cap. Failing to read
 * or write it never breaks the UI.
 */
export class PromptHistory {
  readonly file: string | undefined
  readonly limit: number
  #entries: HistoryEntry[] | undefined

  constructor(opts: PromptHistoryOptions = {}) {
    this.file = opts.file
    this.limit = opts.limit ?? HISTORY_LIMIT
  }

  /** The history of the project in `cwd`: `<AMIRA_HOME or ~/.amira>/history/<project key>.jsonl`. */
  static forProject(cwd: string, home = amiraHome()): PromptHistory {
    return new PromptHistory({ file: path.join(home, "history", `${projectKey(cwd)}.jsonl`) })
  }

  get entries(): readonly HistoryEntry[] {
    this.#entries ??= this.#load()
    return this.#entries
  }

  add(parts: EditorPart[]): void {
    const e = entry(parts)
    if (!e.text.trim()) return
    const entries = this.entries as HistoryEntry[]
    const i = entries.findIndex((x) => x.text === e.text)
    if (i !== -1) entries.splice(i, 1)
    entries.push(e)
    if (entries.length > this.limit) entries.splice(0, entries.length - this.limit)
    if (!this.file || e.text.length > MAX_SAVED_CHARS) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${serialize(e)}\n`)
    } catch {
      // The history is a convenience; a read-only home must not stop the message.
    }
  }

  #load(): HistoryEntry[] {
    if (!this.file) return []
    let raw: string
    try {
      raw = readFileSync(this.file, "utf8")
    } catch {
      return []
    }
    const lines = raw.split("\n").filter((l) => l.trim())
    // Later lines win: walk from the end, keep the first of each text, then restore the order.
    const seen = new Set<string>()
    const kept: HistoryEntry[] = []
    for (let i = lines.length - 1; i >= 0 && kept.length < this.limit; i--) {
      const parts = parseLine(lines[i]!)
      if (!parts) continue
      const e = entry(parts)
      if (seen.has(e.text)) continue
      seen.add(e.text)
      kept.push(e)
    }
    kept.reverse()
    if (lines.length >= 2 * this.limit) this.#rewrite(kept)
    return kept
  }

  #rewrite(entries: HistoryEntry[]): void {
    if (!this.file) return
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, entries.map((e) => `${serialize(e)}\n`).join(""))
      renameSync(tmp, this.file)
    } catch {
      // Left as it is; the next load dedupes again.
    }
  }
}

/**
 * Walks the history with ↑/↓ (Claude Code's rule): only on an empty editor, or while the editor
 * holds an entry it recalled and the user has not edited it, with the caret on its first row
 * (↑) or last row (↓), as drawn: a long line wraps over several. Walking past the newest entry empties the editor again.
 */
export class HistoryNavigator {
  /** Index of the recalled entry; `entries.length` when none is. */
  #index = -1
  /** The editor's version right after the recall; any other version means it was edited. */
  #recalled = -1

  constructor(
    private history: PromptHistory,
    private editor: Editor,
  ) {}

  /** Whether the editor still shows what was recalled. */
  get recalling(): boolean {
    return this.#index !== -1 && this.editor.version === this.#recalled
  }

  /** Handles ↑ (-1) or ↓ (1); false leaves the key to the editor. */
  move(dir: -1 | 1): boolean {
    const entries = this.history.entries
    const recalling = this.recalling
    if (!recalling) this.#index = -1
    // Rows as drawn: in a recalled entry that wraps, ↑ first walks up its rows.
    if (recalling) {
      if (dir === -1 && !this.editor.onFirstRow) return false
      if (dir === 1 && !this.editor.onLastRow) return false
    } else if (!this.editor.isEmpty || dir === 1 || !entries.length) {
      return false
    }
    const from = this.#index === -1 ? entries.length : this.#index
    const to = from + dir
    if (to < 0) return true
    if (to >= entries.length) {
      this.editor.clear()
      this.#index = -1
      return true
    }
    this.editor.setParts(entries[to]!.parts)
    // Going up, the caret goes to the first line so that ↑ keeps walking.
    if (dir === -1) this.editor.setCursor({ line: 0, col: Number.POSITIVE_INFINITY })
    this.#index = to
    this.#recalled = this.editor.version
    return true
  }

  /** Forgets the walk, e.g. once the message is sent. */
  reset(): void {
    this.#index = -1
  }
}
