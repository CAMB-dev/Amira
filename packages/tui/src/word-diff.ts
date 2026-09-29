/** A range `[start, end)` of a line's text. */
export type Range = [number, number]

/** Words, runs of blanks, and single other characters: what a word diff compares. */
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu

/** Longer lines are not compared word by word (the comparison grows with the product of their tokens). */
export const WORD_DIFF_MAX_CHARS = 400
const MAX_CELLS = 20_000
/** Below this share of their text in common, two lines are different lines, not an edited one. */
const MIN_SIMILARITY = 0.4

/**
 * The words that changed between a removed line and the added line that replaced it: the
 * ranges of each that are not in their longest common subsequence of tokens. Blanks between
 * two changed words count as changed, so an edit reads as one stretch. Undefined when the lines
 * are too long to compare, or have too little in common for words to say more than the lines.
 */
export function wordDiff(before: string, after: string): { before: Range[]; after: Range[] } | undefined {
  if (before.length > WORD_DIFF_MAX_CHARS || after.length > WORD_DIFF_MAX_CHARS) return undefined
  const a = before.match(TOKEN) ?? []
  const b = after.match(TOKEN) ?? []
  if (a.length * b.length > MAX_CELLS) return undefined
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..], in tokens.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const keptA = new Array<boolean>(a.length).fill(false)
  const keptB = new Array<boolean>(b.length).fill(false)
  let common = 0
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keptA[i] = true
      keptB[j] = true
      if (a[i]!.trim()) common += a[i]!.length
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++
    else j++
  }
  const solid = (s: string) => s.replace(/\s+/g, "").length
  const total = solid(before) + solid(after)
  if (total === 0 || (2 * common) / total < MIN_SIMILARITY) return undefined
  return { before: ranges(a, keptA), after: ranges(b, keptB) }
}

/** The ranges of the tokens not kept, joined across blanks between them. */
function ranges(tokens: string[], kept: boolean[]): Range[] {
  const out: Range[] = []
  let at = 0
  let open: Range | undefined
  tokens.forEach((t, i) => {
    const end = at + t.length
    if (!kept[i]) {
      // Extends over a blank kept since the last changed word: another changed word follows it.
      if (open) open[1] = end
      else open = [at, end]
    } else if (open && t.trim()) {
      out.push(open)
      open = undefined
    }
    at = end
  })
  if (open) out.push(open)
  // Blanks at either end of a stretch are not what changed.
  const text = tokens.join("")
  return out
    .map(([start, end]): Range => {
      while (start < end && /\s/.test(text[start]!)) start++
      while (end > start && /\s/.test(text[end - 1]!)) end--
      return [start, end]
    })
    .filter(([start, end]) => end > start)
}
