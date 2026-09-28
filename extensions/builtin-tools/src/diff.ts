import type { DiffHunk, FileDiff } from "@amira/api"

/** Unchanged lines kept around each change. */
export const CONTEXT_LINES = 2
/** Most hunk lines kept in a result's details; the rest is only counted. */
export const MAX_HUNK_LINES = 400
/** Beyond this many differing lines the middle is shown as replaced instead of diffed. */
const MAX_EDIT_DISTANCE = 1000

type Op = { op: " " | "-" | "+"; text: string }

/** Lines of a text without their line endings; a final line break does not start a line. */
export function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** The change from `before` to `after` as unified-diff hunks (line numbers 1-based). */
export function fileDiff(before: string, after: string, context = CONTEXT_LINES): FileDiff {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const middle = diffMiddle(a.slice(start, endA), b.slice(start, endB))
  const ops: Op[] = [
    ...a.slice(0, start).map((text) => ({ op: " " as const, text })),
    ...middle,
    ...a.slice(endA).map((text) => ({ op: " " as const, text })),
  ]
  return toHunks(ops, context)
}

/** Myers' diff of two line arrays; a replace of everything once they differ too much. */
function diffMiddle(a: string[], b: string[]): Op[] {
  const replaced = (): Op[] => [
    ...a.map((text) => ({ op: "-" as const, text })),
    ...b.map((text) => ({ op: "+" as const, text })),
  ]
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return replaced()
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max + 1
  let v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    const next = v.slice()
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      next[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, next, d, k, a, b, offset)
    }
    v = next
  }
  return replaced()
}

function backtrack(
  trace: Int32Array[],
  last: Int32Array,
  dEnd: number,
  kEnd: number,
  a: string[],
  b: string[],
  offset: number,
): Op[] {
  const out: Op[] = []
  let x = last[offset + kEnd]!
  let y = x - kEnd
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]!
    const k = x - y
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
    const prevK = down ? k + 1 : k - 1
    const prevX = v[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      out.push({ op: " ", text: a[x - 1]! })
      x--
      y--
    }
    if (down) out.push({ op: "+", text: b[y - 1]! })
    else out.push({ op: "-", text: a[x - 1]! })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    out.push({ op: " ", text: a[x - 1]! })
    x--
    y--
  }
  return out.reverse()
}

function toHunks(ops: Op[], context: number): FileDiff {
  const hunks: DiffHunk[] = []
  let added = 0
  let removed = 0
  let kept = 0
  let truncated = false
  const changed = ops.map((o) => o.op !== " ")
  // Old and new line numbers before each op.
  const oldNo: number[] = []
  const newNo: number[] = []
  let on = 1
  let nn = 1
  for (const o of ops) {
    oldNo.push(on)
    newNo.push(nn)
    if (o.op !== "+") on++
    if (o.op !== "-") nn++
    if (o.op === "+") added++
    if (o.op === "-") removed++
  }
  let i = 0
  while (i < ops.length) {
    if (!changed[i]) {
      i++
      continue
    }
    const from = Math.max(0, i - context)
    let to = i
    // Extend over changes separated by at most 2 × context unchanged lines.
    for (;;) {
      while (to < ops.length && changed[to]) to++
      let gap = to
      while (gap < ops.length && !changed[gap] && gap - to < 2 * context) gap++
      if (gap < ops.length && changed[gap] && gap - to <= 2 * context) to = gap
      else break
    }
    const end = Math.min(ops.length, to + context)
    const slice = ops.slice(from, end)
    if (kept + slice.length > MAX_HUNK_LINES) {
      truncated = true
      break
    }
    kept += slice.length
    hunks.push({
      oldStart: oldNo[from]!,
      oldLines: slice.filter((o) => o.op !== "+").length,
      newStart: newNo[from]!,
      newLines: slice.filter((o) => o.op !== "-").length,
      lines: slice.map((o) => o.op + o.text),
    })
    i = end
  }
  return { hunks, added, removed, ...(truncated ? { truncated } : {}) }
}
