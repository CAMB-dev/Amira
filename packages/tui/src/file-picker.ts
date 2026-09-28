import { type Component, type InputEvent, isSubmitKey, matchesKey, type RenderContext } from "@amira/tui-kit"
import type { FileSource } from "./file-index.ts"
import { AsyncList } from "./picker.ts"

/** Candidates the picker ranks and keeps. */
const MAX_RESULTS = 50

/** The `@word` being typed at the end of `beforeCaret`, if any. */
export function atReference(beforeCaret: string): { query: string } | undefined {
  const m = /(?:^|\s)@([^\s@"]*)$/.exec(beforeCaret)
  return m ? { query: m[1]! } : undefined
}

const BOUNDARY = new Set(["/", "\\", "-", "_", ".", " "])

/** Points for `q` as a subsequence of `c` from `from`, favoring runs and word starts; undefined when it is not one. */
function subsequence(q: string, c: string, from: number): number | undefined {
  let score = 0
  let prev = -2
  let pos = from
  let first = -1
  for (const ch of q) {
    const i = c.indexOf(ch, pos)
    if (i === -1) return undefined
    if (first === -1) first = i
    if (i === prev + 1) score += 5
    if (i === 0 || BOUNDARY.has(c[i - 1]!)) score += 8
    score += 1
    prev = i
    pos = i + 1
  }
  // Matches spread far apart are worth less.
  return score - (prev - first + 1 - q.length) * 0.5
}

/**
 * How well `query` matches `path` (both lower-cased), higher is better; undefined for no match.
 * The file name counts most: an exact name, then a name that starts with or contains the query,
 * then the path containing it, then the letters in order (in the name, then anywhere). Shorter,
 * shallower paths win ties. A query with a "/" is matched against the whole path only.
 */
export function fuzzyScore(query: string, path: string): number | undefined {
  if (!query) return 0
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path
  const nameStart = trimmed.lastIndexOf("/") + 1
  const name = trimmed.slice(nameStart)
  const byName = !query.includes("/")
  let s: number | undefined
  if (byName && name === query) s = 1000
  else if (byName && name.startsWith(query)) s = 900
  else if (byName && name.includes(query)) s = 800
  else if (path.startsWith(query)) s = 750
  else if (path.includes(query)) {
    const i = path.indexOf(query)
    s = 700 + (BOUNDARY.has(path[i - 1]!) ? 20 : 0)
  } else {
    const inName = byName ? subsequence(query, path, nameStart) : undefined
    if (inName !== undefined) s = 400 + inName
    else {
      const anywhere = subsequence(query, path, 0)
      if (anywhere === undefined) return undefined
      s = 200 + anywhere
    }
  }
  // Among names that contain the query, the one closest to it in length wins.
  if (s >= 800) s -= (name.length - query.length) * 2
  let depth = 0
  for (let i = trimmed.indexOf("/"); i !== -1; i = trimmed.indexOf("/", i + 1)) depth++
  return s - path.length * 0.3 - depth * 2
}

const lowered = new WeakMap<string[], string[]>()

/** The best `limit` matches of `query` among `paths`; without a query the shallowest paths, in order. */
export function rankFiles(query: string, paths: string[], limit = MAX_RESULTS): string[] {
  const q = query.toLowerCase()
  if (!q) {
    const depth = (p: string) => p.replace(/\/$/, "").split("/").length
    return [...paths].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit)
  }
  let lower = lowered.get(paths)
  if (!lower) {
    lower = paths.map((p) => p.toLowerCase())
    lowered.set(paths, lower)
  }
  const scored: { path: string; score: number }[] = []
  for (let i = 0; i < paths.length; i++) {
    const score = fuzzyScore(q, lower[i]!)
    if (score !== undefined) scored.push({ path: paths[i]!, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
  return scored.slice(0, limit).map((s) => s.path)
}

/** What a key did to the picker. */
export type FilePickerAction =
  | { type: "handled" }
  /** Replace the `replace` UTF-16 units before the caret ("@" and the query) with `text`. */
  | { type: "insert"; replace: number; text: string }

/**
 * The file list shown while an `@word` is typed: fuzzy matches over the project's files and
 * directories. ↑↓ select, Tab or Enter insert "@path" (a file gets a space after it, a directory
 * keeps the list open for its contents), Esc closes it until the word changes. The message keeps
 * the "@path" text as typed.
 */
export class FilePicker implements Component {
  #list: AsyncList<string>

  constructor(source: FileSource, onUpdate: () => void) {
    this.#list = new AsyncList((query) => {
      const files = source.files()
      return Array.isArray(files) ? rankFiles(query, files) : files.then((f) => rankFiles(query, f))
    }, onUpdate)
  }

  /**
   * Call with the editor's text before the caret whenever it changed; a promise while the file
   * list is still loading (see AsyncList.update).
   */
  update(beforeCaret: string): Promise<void> | undefined {
    return this.#list.update(atReference(beforeCaret)?.query)
  }

  get open(): boolean {
    return this.#list.open
  }

  get visible(): boolean {
    return this.#list.visible
  }

  /** Handles a key while open; undefined leaves it to the editor. */
  handleKey(e: InputEvent): FilePickerAction | undefined {
    if (!this.open) return undefined
    if (matchesKey(e, "escape")) {
      this.#list.dismiss()
      return { type: "handled" }
    }
    if (matchesKey(e, "up") || matchesKey(e, "down")) {
      this.#list.move(matchesKey(e, "up") ? -1 : 1)
      return { type: "handled" }
    }
    const chosen = this.#list.selected
    if (chosen === undefined || !(matchesKey(e, "tab") || isSubmitKey(e))) return undefined
    const quoted = /\s/.test(chosen) ? `"${chosen}"` : chosen
    const text = `@${quoted}${chosen.endsWith("/") ? "" : " "}`
    return { type: "insert", replace: 1 + (this.#list.key ?? "").length, text }
  }

  render(width: number, ctx: RenderContext): string[] {
    return this.#list.render(width, ctx.theme, (path) => ({ label: path }))
  }
}
