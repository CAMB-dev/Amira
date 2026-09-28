/**
 * Finds the tool a model meant when it got the name slightly wrong (D40): exact, then ignoring
 * case, then ignoring separators (read_file, readFile, read-file), then the closest name by edit
 * distance. Each step only answers when exactly one tool matches.
 */
export function resolveToolName(name: string, known: string[]): string | undefined {
  if (known.includes(name)) return name
  const lower = name.toLowerCase()
  const bare = squash(name)
  const steps: ((k: string) => boolean)[] = [(k) => k.toLowerCase() === lower, (k) => squash(k) === bare]
  for (const matches of steps) {
    const hits = known.filter(matches)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return undefined
  }
  if (bare.length < 3) return undefined
  // Allow about one typo per four characters.
  const limit = Math.max(1, Math.floor(bare.length / 4))
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  let tie = false
  for (const k of known) {
    const d = distance(bare, squash(k))
    if (d < bestDistance) {
      best = k
      bestDistance = d
      tie = false
    } else if (d === bestDistance) tie = true
  }
  return best !== undefined && bestDistance <= limit && !tie ? best : undefined
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[\s_\-.]/g, "")
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]!
}
