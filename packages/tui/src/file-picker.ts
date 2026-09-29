import { type Component, type InputEvent, type RenderContext, Spinner, truncateToWidth } from "@amira/tui-kit"
import type { FileListing, FileSource } from "./file-index.ts"
import { defaultKeybindings, type Keybindings } from "./keybindings.ts"
import { pickerRows } from "./picker.ts"

/** Candidates the picker ranks and keeps. */
const MAX_RESULTS = 50

/**
 * How long a key may search before its frame is drawn, and each later slice before yielding to
 * keys and frames. A small project is searched whole within the first; a big one goes on in
 * slices, its best matches so far shown after each.
 */
const FIRST_SLICE_MS = 4
const SLICE_MS = 6

/** Finished searches kept, to answer a query again (Backspace) at once and to refine from. */
const KEPT_SEARCHES = 16

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
 * shallower paths win ties. A query with a "/" is matched against the whole path only. Every
 * match has the query's letters in order, so what a query does not match, no longer one does.
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

/** Slashes in `p`, a directory's trailing one not counted. */
function depthOf(p: string): number {
  let n = 0
  for (let i = p.indexOf("/"); i !== -1 && i < p.length - 1; i = p.indexOf("/", i + 1)) n++
  return n
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Lower-cased entries of each listing, filled in as they are first searched. */
const lowered = new WeakMap<readonly string[], string[]>()

interface Hit {
  path: string
  score: number
}

/**
 * One query searched over a listing, in slices: it keeps the best `limit` matches so far and the
 * index of every match, so a longer query (the next key) searches only those, plus whatever the
 * listing added since. Without a query the shallowest paths come first, by depth then name.
 */
export class Search {
  /** Indices of the entries that matched, in order; for refining. */
  readonly matched: number[] = []
  #top: Hit[] = []
  /** Candidates from the search this one refines, and how far through them it got. */
  #base: readonly number[] | undefined
  #baseAt = 0
  /** How many of the base's matches are this one's: it may grow on, past `#at`, when searched again. */
  #baseEnd = 0
  /** The next entry to look at past the base's. */
  #at: number
  #lower: string[]
  readonly #compare: (a: Hit, b: Hit) => number
  readonly #skip: string | undefined

  constructor(
    /** As typed; matched lower-cased. */
    readonly query: string,
    readonly entries: readonly string[],
    readonly limit = MAX_RESULTS,
    refines?: Search,
  ) {
    const q = query.toLowerCase()
    this.#skip = q.endsWith("/") ? q : undefined
    let lower = lowered.get(entries)
    if (!lower) {
      lower = []
      lowered.set(entries, lower)
    }
    this.#lower = lower
    this.#compare = q
      ? (a, b) => b.score - a.score || a.path.length - b.path.length || byName(a.path, b.path)
      : (a, b) => b.score - a.score || byName(a.path, b.path)
    if (refines && q && refines.canRefine(q, entries)) {
      this.#base = refines.matched
      this.#baseEnd = refines.matched.length
      this.#at = refines.#at
    } else this.#at = 0
  }

  /** Whether a search for `q` over `entries` may start from this one's matches. */
  canRefine(q: string, entries: readonly string[]): boolean {
    const mine = this.query.toLowerCase()
    return !!mine && entries === this.entries && q !== mine && q.startsWith(mine) && this.#baseDone
  }

  get #baseDone(): boolean {
    return this.#base === undefined || this.#baseAt >= this.#baseEnd
  }

  /** It has looked at every entry the listing holds now. */
  get caughtUp(): boolean {
    return this.#baseDone && this.#at >= this.entries.length
  }

  /** The best matches so far, best first. */
  get results(): string[] {
    return this.#top.map((h) => h.path)
  }

  /** Searches until `deadline` (performance.now()) or until caught up; true when caught up. */
  step(deadline: number): boolean {
    const q = this.query.toLowerCase()
    const base = this.#base
    let n = 0
    while (base && this.#baseAt < this.#baseEnd) {
      this.#look(base[this.#baseAt++]!, q)
      if (++n % 256 === 0 && performance.now() >= deadline) return this.caughtUp
    }
    while (this.#at < this.entries.length) {
      this.#look(this.#at++, q)
      if (++n % 256 === 0 && performance.now() >= deadline) return this.caughtUp
    }
    return true
  }

  #look(i: number, q: string) {
    const path = this.entries[i]!
    let score: number | undefined
    if (q) {
      let lower = this.#lower[i]
      if (lower === undefined) {
        lower = path.toLowerCase()
        this.#lower[i] = lower
      }
      if (lower === this.#skip) return
      score = fuzzyScore(q, lower)
      if (score === undefined) return
      this.matched.push(i)
    } else score = -depthOf(path)
    this.#offer({ path, score })
  }

  /** Keeps `hit` if it is among the best `limit`, in order. */
  #offer(hit: Hit) {
    const top = this.#top
    if (top.length === this.limit && this.#compare(hit, top[top.length - 1]!) >= 0) return
    let lo = 0
    let hi = top.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.#compare(top[mid]!, hit) <= 0) lo = mid + 1
      else hi = mid
    }
    top.splice(lo, 0, hit)
    if (top.length > this.limit) top.pop()
  }
}

const shallowest = new WeakMap<readonly string[], { length: number; limit: number; result: string[] }>()

/**
 * The best `limit` matches of `query` among `paths`; without a query the shallowest paths, in
 * order (cached per list, since a bare "@" asks for them each time). A directory equal to the
 * query (just inserted, "@src/") is left out, so the list shows its contents.
 */
export function rankFiles(query: string, paths: readonly string[], limit = MAX_RESULTS): string[] {
  if (!query) {
    const cached = shallowest.get(paths)
    if (cached && cached.length === paths.length && cached.limit === limit) return cached.result.slice()
  }
  const search = new Search(query, paths, limit)
  search.step(Number.POSITIVE_INFINITY)
  if (!query) shallowest.set(paths, { length: paths.length, limit, result: search.results })
  return search.results
}

/** What a key did to the picker. */
export type FilePickerAction =
  | { type: "handled" }
  /** Replace the `replace` UTF-16 units before the caret ("@" and the query) with `text`. */
  | { type: "insert"; replace: number; text: string }

const count = (n: number) => n.toLocaleString("en-US")

/**
 * The file list shown while an `@word` is typed: fuzzy matches over the project's files and
 * directories. ↑↓ select, Tab or Enter insert "@path" (a file gets a space after it, a directory
 * keeps the list open for its contents), Esc closes it until the word changes. The message keeps
 * the "@path" text as typed.
 *
 * Typing never waits for it: the project is listed in the background (a status row counts the
 * files found meanwhile), and a key searches for at most a few milliseconds before its frame is
 * drawn; a big listing is searched on in slices between keys and frames, the best matches so far
 * shown as they come.
 */
export class FilePicker implements Component {
  #query: string | undefined
  #listing: FileListing | undefined
  #search: Search | undefined
  /** Finished searches, oldest first. */
  #kept: Search[] = []
  #results: string[] = []
  /**
   * The results are the last query's: the new one found nothing yet but is still searching. They
   * stay drawn so the list does not blink out on each key, but do not take keys.
   */
  #stale = false
  #selected = 0
  #navigated = false
  #dismissed = false
  #scheduled: ReturnType<typeof setImmediate> | undefined
  #spinner = new Spinner()
  #spinning = false
  #off: () => void

  constructor(
    private source: FileSource,
    private onUpdate: () => void,
    private keys: Keybindings = defaultKeybindings(),
  ) {
    this.#off = source.subscribe(() => this.#grown())
  }

  /** Call with the editor's text before the caret whenever it changed. Never waits for the listing. */
  update(beforeCaret: string): void {
    const query = atReference(beforeCaret)?.query
    if (query === this.#query) return
    this.#query = query
    this.#dismissed = false
    this.#navigated = false
    this.#selected = 0
    if (query === undefined) {
      this.#stop()
      this.#results = []
      this.#stale = false
      this.#search = undefined
      return
    }
    const listing = this.source.listing()
    // Searches of a listing that was replaced are no use any more.
    if (listing !== this.#listing) this.#kept = []
    this.#listing = listing
    this.#begin(FIRST_SLICE_MS)
  }

  /** Starts searching the query over the listing, from a kept search when one fits. */
  #begin(budgetMs: number) {
    const query = this.#query!
    const entries = this.#listing!.entries
    const q = query.toLowerCase()
    const same = this.#kept.findLast((s) => s.entries === entries && s.query.toLowerCase() === q)
    const refines = this.#kept.findLast((s) => s.canRefine(q, entries))
    this.#search = same ?? new Search(query, entries, MAX_RESULTS, refines)
    if (budgetMs > 0) this.#run(budgetMs)
    else this.#schedule()
  }

  /** Searches for up to `budgetMs`, shows what it found, and goes on later if there is more. */
  #run(budgetMs: number) {
    const search = this.#search
    if (!search) return
    const done = search.step(performance.now() + budgetMs)
    this.#show(search.results, done)
    if (done) this.#keep(search)
    else this.#schedule()
    this.#spin()
  }

  #schedule() {
    this.#scheduled ??= setImmediate(() => {
      this.#scheduled = undefined
      this.#run(SLICE_MS)
      this.onUpdate()
    })
  }

  #keep(search: Search) {
    const i = this.#kept.indexOf(search)
    if (i !== -1) this.#kept.splice(i, 1)
    this.#kept.push(search)
    if (this.#kept.length > KEPT_SEARCHES) this.#kept.shift()
  }

  /**
   * New results, `final` once the search caught up; until then no results yet leave the last ones
   * drawn. The selection stays on the path the user moved to, if it is still there.
   */
  #show(results: string[], final: boolean) {
    this.#stale = !results.length && !final && this.#results.length > 0
    if (this.#stale) return
    const chosen = this.#navigated ? this.#results[this.#selected] : undefined
    this.#results = results
    const at = chosen === undefined ? -1 : results.indexOf(chosen)
    if (at === -1) {
      this.#selected = 0
      this.#navigated = false
    } else this.#selected = at
  }

  /** The listing grew or was replaced: search what it added, or search the fresh one. */
  #grown() {
    if (this.#query === undefined) return
    const listing = this.source.listing()
    if (listing !== this.#listing) {
      this.#listing = listing
      this.#kept = []
      this.#begin(0)
    } else if (this.#search) this.#schedule()
    this.#spin()
    this.onUpdate()
  }

  get #indexing(): boolean {
    return this.#query !== undefined && !!this.#listing && !this.#listing.done
  }

  /** The spinner of the status row turns while the listing loads and the list is shown. */
  #spin() {
    const on = this.#indexing && !this.#dismissed
    if (on && !this.#spinning) this.#spinner.start(() => this.onUpdate())
    else if (!on && this.#spinning) this.#spinner.stop()
    this.#spinning = on
  }

  #stop() {
    if (this.#scheduled) clearImmediate(this.#scheduled)
    this.#scheduled = undefined
    this.#spinner.stop()
    this.#spinning = false
  }

  /** Stops its timers and leaves the source; the UI is quitting. */
  dispose(): void {
    this.#stop()
    this.#off()
  }

  /** Whether it takes the list keys: there are matches of the query to choose from. */
  get open(): boolean {
    return !this.#dismissed && this.#query !== undefined && this.#results.length > 0 && !this.#stale
  }

  /**
   * Whether it is drawn: matches, the last query's while the new one is searched, or the status
   * row while the project is listed. Then the list keys wait for the matches (Esc closes it).
   */
  get visible(): boolean {
    return !this.#dismissed && this.#query !== undefined && (this.#results.length > 0 || this.#indexing)
  }

  /** Handles a key while shown; undefined leaves it to the editor. */
  handleKey(e: InputEvent): FilePickerAction | undefined {
    if (!this.visible) return undefined
    // The completion lists share their keys: the popup.* actions.
    const keys = this.keys
    if (keys.is(e, "popup.close")) {
      this.#dismissed = true
      this.#spin()
      return { type: "handled" }
    }
    const listKey = ["popup.up", "popup.down", "popup.complete", "popup.accept"] as const
    // Shown but with nothing of this query to choose yet: the keys it names do nothing, rather
    // than sending the half-typed "@word" or walking the prompt history.
    if (!this.open) return listKey.some((a) => keys.is(e, a)) ? { type: "handled" } : undefined
    const n = this.#results.length
    if (keys.is(e, "popup.up") || keys.is(e, "popup.down")) {
      this.#selected = (this.#selected + (keys.is(e, "popup.up") ? -1 : 1) + n) % n
      this.#navigated = true
      return { type: "handled" }
    }
    const chosen = this.#results[this.#selected]
    if (chosen === undefined || !(keys.is(e, "popup.complete") || keys.is(e, "popup.accept")))
      return undefined
    const quoted = /\s/.test(chosen) ? `"${chosen}"` : chosen
    const text = `@${quoted}${chosen.endsWith("/") ? "" : " "}`
    return { type: "insert", replace: 1 + (this.#query ?? "").length, text }
  }

  render(width: number, ctx: RenderContext): string[] {
    if (!this.visible) return []
    const t = ctx.theme
    const rows = this.#results.length
      ? pickerRows(
          this.#results.map((label) => ({ label })),
          this.#selected,
          width,
          t,
        )
      : []
    const listing = this.#listing
    if (this.#indexing && listing) {
      const status = `${t.accent(this.#spinner.glyph)} ${t.muted(`indexing… ${count(listing.files)} files`)}`
      rows.push(truncateToWidth(status, width, "…"))
    } else if (listing?.partial) {
      rows.push(truncateToWidth(t.muted(`  searched the first ${count(listing.files)} files`), width, "…"))
    }
    return rows
  }
}
