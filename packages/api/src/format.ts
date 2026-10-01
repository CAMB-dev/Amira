import { truncateToWidth, visibleWidth } from "@amira/text-width"

/**
 * Shared formatting for numbers, times and text in terminal cells, so every screen writes a
 * duration, a token count or a count of things the same way.
 */

/** A count with its noun: "1 line", "3 lines", "2 matches" (with `many`). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Compact token counts: 999, 1.2k, 46k, 2.5M. Rounds before picking the unit. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  const k = n / 1000
  if (Number(k.toFixed(1)) < 10) return `${k.toFixed(1)}k`
  if (Math.round(k) < 1000) return `${Math.round(k)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Minutes and hours of a whole number of seconds: "1m 05s", "1h 02m". */
function longDuration(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`
}

/** How long something took: "0.4s", "12.3s", "2m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (Math.round(safe / 100) < 600) return `${(safe / 1000).toFixed(1)}s`
  return longDuration(Math.round(safe / 1000))
}

/** How long something has run so far, in whole seconds so it ticks calmly: "4s", "1m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return sec < 60 ? `${sec}s` : longDuration(sec)
}

/**
 * `text` cut to at most `cells` terminal cells, ending in `ellipsis` when cut. Wide characters
 * (CJK, emoji) count as two cells and are never split; styles are closed where it cuts.
 */
export function clip(text: string, cells: number, ellipsis = "…"): string {
  if (cells <= 0) return ""
  return visibleWidth(text) > cells ? truncateToWidth(text, cells, ellipsis) : text
}

/**
 * `text` (without escape sequences) cut to `cells` terminal cells in its middle, so both ends
 * stay: a path keeps its file name ("src/…/deep/file.ts"), a command its start and its end.
 * The end kept is at least the last path segment when that fits, else half of what fits.
 */
export function clipMiddle(text: string, cells: number, ellipsis = "…"): string {
  if (visibleWidth(text) <= cells) return text
  const mark = visibleWidth(ellipsis)
  if (cells <= mark + 1) return clip(text, cells, ellipsis)
  const room = cells - mark
  const sep = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"))
  const base = sep >= 0 ? visibleWidth(text.slice(sep)) : 0
  const tailCells = Math.min(room - 1, Math.max(Math.ceil(room / 2), base))
  const chars = [...text]
  let tail = ""
  for (let i = chars.length - 1; i >= 0; i--) {
    if (visibleWidth(chars[i]! + tail) > tailCells) break
    tail = chars[i]! + tail
  }
  const head = truncateToWidth(text, room - visibleWidth(tail))
  return `${head}${ellipsis}${tail}`
}

/** `text` padded with spaces to `cells` terminal cells (never cut), for columns that line up. */
export function padCells(text: string, cells: number): string {
  return text + " ".repeat(Math.max(0, cells - visibleWidth(text)))
}

/** Width of `text` in terminal cells, escape sequences ignored. */
export function textCells(text: string): number {
  return visibleWidth(text)
}
