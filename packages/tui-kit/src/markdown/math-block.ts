import { type BlockState, cloneState, type Env, finish, type Sink, step } from "./blocks.ts"
import { type DisplayMathStart, displayMathEnd, displayMathSource, displayMathStart } from "./math-source.ts"

export interface MathBlock {
  opener: DisplayMathStart
  lines: string[]
  col: number
  indent: number
}

/** The legacy Markdown environment: raw math still has its old emphasis/escape semantics. */
function legacy(env: Env): Env {
  return { ...env, claimsMath: undefined, math: undefined, inlineMath: undefined }
}

function replay(s: BlockState, lines: string[], env: Env, sink: Sink): void {
  s.math = undefined
  for (const line of lines) step(s, line, legacy(env), sink)
}

/** The raw Markdown fallback, without mutating the stream or invoking math renderers. */
export function mathRows(s: BlockState, env: Env): string[] {
  if (!s.math) return []
  const copy = cloneState(s)
  copy.blankPending = false
  copy.emitted = false
  const rows: string[] = []
  replay(copy, s.math.lines, env, (r) => rows.push(...r))
  finish(copy, legacy(env), (r) => rows.push(...r))
  return rows
}

/** Starts or extends a claimed display block; only a real closing delimiter invokes its renderer. */
export function stepMath(s: BlockState, line: string, env: Env, sink: Sink, emit: Sink): boolean {
  let block = s.math
  if (!block) {
    if (!env.math || (!env.claimsMath?.(true) && !env.inlineMath)) return false
    const opener = displayMathStart(line)
    if (!opener || env.mathCode?.some(({ start, end }) => start <= opener.from && end > 0)) return false
    const indent = line.length - line.trimStart().length
    const list = s.list.filter((entry) => entry.contentCol <= indent)
    block = { opener, lines: [], col: list[list.length - 1]?.renderCol ?? 0, indent }
    s.math = block
  }
  block.lines.push(line)
  const from = block.lines.length === 1 ? block.opener.from : 0
  if (displayMathEnd(line, block.opener.close, from) === undefined) return true
  const fallback = mathRows(s, env)
  const rows = env.claimsMath?.(true)
    ? env.math!(displayMathSource(block.lines, block.opener), fallback, block.col)
    : fallback
  s.math = undefined
  if (rows.length === fallback.length && rows.every((row, i) => row === fallback[i]))
    replay(s, block.lines, env, sink)
  else {
    // Like a fence, an accepted display ends lists outside its source indentation.
    while (s.list.length && s.list[s.list.length - 1]!.contentCol > block.indent) s.list.pop()
    for (const col of s.ordinals.keys()) if (col >= block.indent) s.ordinals.delete(col)
    s.paragraph = false
    s.prevBlank = false
    emit(rows)
  }
  return true
}

/** An unclosed display is ordinary Markdown, even at end-of-stream. */
export function finishMath(s: BlockState, env: Env, sink: Sink): void {
  if (!s.math) return
  replay(s, s.math.lines, env, sink)
  finish(s, legacy(env), sink)
}
