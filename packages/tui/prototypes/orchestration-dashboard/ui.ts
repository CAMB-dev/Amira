// PROTOTYPE — not production. Drawing helpers shared by the three dashboard variants.
import {
  bg256,
  bold,
  compose,
  cyan,
  dim,
  fg256,
  graphemes,
  gray,
  green,
  italic,
  red,
  type StyleFn,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  white,
  wrapText,
  yellow,
} from "@amira/tui-kit"
import type { Agent, FileChange, LogLine, Phase, Run, Status, Step } from "./sim.ts"
import { ended, live, topLevel } from "./sim.ts"

export const C = {
  accent: cyan,
  muted: gray,
  ok: green,
  err: red,
  warn: yellow,
  run: fg256(214),
  border: fg256(240),
  focusBorder: fg256(214),
  sel: bg256(237),
  title: bold,
  add: green,
  del: red,
  hunk: cyan,
  think: compose(italic, gray),
  user: fg256(141),
  bar: compose(bg256(54), white),
  barKey: compose(bg256(54), bold, fg256(229)),
  tag: fg256(111),
  dim,
}

// ---------------------------------------------------------------------------------------------
// Width-safe text

export const vw = visibleWidth

/** Exactly `w` cells: cut with "…" or padded with spaces. */
export function fit(s: string, w: number): string {
  if (w <= 0) return ""
  const t = vw(s) > w ? truncateToWidth(s, w, "…") : s
  return t + " ".repeat(Math.max(0, w - vw(t)))
}

/** `left` and `right` on one row of `w` cells; the left side gives way. */
export function lr(left: string, right: string, w: number): string {
  const rw = vw(right)
  if (rw + 1 >= w) return fit(right, w)
  return fit(left, w - rw - 1) + " " + right
}

export function wrap(s: string, w: number): string[] {
  return wrapText(s, Math.max(1, w))
}

/** Pads a column of lines to `h` rows of `w` cells (cutting what does not fit). */
export function block(lines: string[], w: number, h: number): string[] {
  const out = lines.slice(0, h).map((l) => fit(l, w))
  while (out.length < h) out.push(" ".repeat(w))
  return out
}

/** Places columns side by side; each is `{ lines, w }`, all padded to the tallest. */
export function hjoin(cols: { lines: string[]; w: number }[], sep = ""): string[] {
  const h = Math.max(...cols.map((c) => c.lines.length))
  const blocks = cols.map((c) => block(c.lines, c.w, h))
  return Array.from({ length: h }, (_, i) => blocks.map((b) => b[i]).join(sep))
}

/** A rounded box of exactly `w`×`h` with an optional title in the top border. */
export function frame(
  lines: string[],
  w: number,
  h: number,
  opts: { title?: string; right?: string; color?: StyleFn; heavy?: boolean; bottom?: string } = {},
): string[] {
  const b = opts.color ?? C.border
  const [tl, tr, bl, br, hz, vt] = opts.heavy
    ? ["┏", "┓", "┗", "┛", "━", "┃"]
    : ["╭", "╮", "╰", "╯", "─", "│"]
  const inner = w - 2
  const edge = (l: string, r: string, label = "", rlabel = "") => {
    const ll = label ? ` ${label} ` : ""
    const rl = rlabel ? ` ${rlabel} ` : ""
    const lab = truncateToWidth(ll, Math.max(0, inner - 1), "…")
    const room = inner - 1 - vw(lab) - vw(rl)
    if (room < 1) return b(l) + b(hz) + lab + b(hz.repeat(Math.max(0, inner - 1 - vw(lab)))) + b(r)
    return b(l + hz) + lab + b(hz.repeat(room)) + rl + b(r)
  }
  const body = block(lines, inner, Math.max(0, h - 2)).map((l) => b(vt) + l + b(vt))
  return [edge(tl, tr, opts.title, opts.right), ...body, edge(bl, br, opts.bottom)].slice(0, h)
}

export function rule(w: number, label = "", color: StyleFn = C.border): string {
  if (!label) return color("─".repeat(w))
  const l = ` ${label} `
  return color("──") + l + color("─".repeat(Math.max(0, w - 2 - vw(l))))
}

/** Highlights a whole row as selected. */
export function selRow(s: string, w: number, on: boolean): string {
  const f = fit(s, w)
  return on ? C.sel(f) : f
}

/** Paints `box` over `base` at column `x`, row `y`; the base is dimmed and loses its colors. */
export function overlay(base: string[], box: string[], x: number, y: number, dimBase = true): string[] {
  const out = base.map((l) => (dimBase ? C.muted(stripAnsi(l)) : l))
  box.forEach((line, i) => {
    const row = y + i
    if (row < 0 || row >= out.length) return
    const plain = stripAnsi(base[row] ?? "")
    const left = fit(cutCols(plain, 0, x), x)
    const right = cutCols(plain, x + vw(line), 10_000)
    out[row] = (dimBase ? C.muted(left) : left) + line + "\x1b[0m" + (dimBase ? C.muted(right) : right)
  })
  return out
}

/** Columns [from, to) of a plain string; a wide character cut in half becomes spaces. */
export function cutCols(s: string, from: number, to: number): string {
  let col = 0
  let out = ""
  for (const g of graphemes(s)) {
    const w = Bun.stringWidth(g)
    const a = col
    const b = col + w
    col = b
    if (b <= from) continue
    if (a >= to) break
    if (a >= from && b <= to) out += g
    else out += " ".repeat(Math.min(b, to) - Math.max(a, from))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Formatting

const BASE = 10 * 3600 + 12 * 60 + 31

export function clock(t: number): string {
  const s = Math.floor(BASE + t)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
}

export function dur(s: number): string {
  const n = Math.max(0, Math.floor(s))
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`
}

export function tok(n: number): string {
  return n < 1000 ? `${Math.round(n)}` : `${(n / 1000).toFixed(1)}k`
}

export const cost = (n: number) => `$${n.toFixed(4)}`

export function runtime(run: Run, a: Agent): string {
  if (a.startedAt === undefined) return "—"
  return dur((a.endedAt ?? run.clock) - a.startedAt)
}

export function totals(run: Run) {
  const tokens = run.agents.reduce((s, a) => s + a.tokens, 0)
  const c = run.agents.reduce((s, a) => s + a.cost, 0)
  const top = topLevel(run)
  return {
    tokens,
    cost: c,
    running: top.filter(live).length,
    total: top.length,
    approvals: run.agents.filter((a) => a.status === "approval").length,
    done: top.filter(ended).length,
  }
}

export function currentPhase(run: Run): Phase {
  return run.phases.find((p) => p.status === "running") ?? run.phases[run.phases.length - 1]!
}

// ---------------------------------------------------------------------------------------------
// Glyphs

export function glyph(s: Status, t = 0): string {
  switch (s) {
    case "done":
      return C.ok("✓")
    case "failed":
      return C.err("✗")
    case "running":
      return t >= 0 ? C.run("●") : ""
    case "paused":
      return C.warn("‖")
    case "approval":
      return C.warn(bold("?"))
    case "queued":
      return C.muted("○")
  }
}

export function phaseGlyph(p: Phase, t = 0): string {
  if (p.status === "done") return C.ok("✓")
  if (p.status === "failed") return C.err("✗")
  if (p.status === "running") return glyph("running", t)
  return C.muted("○")
}

export function statusWord(a: Agent): string {
  switch (a.status) {
    case "approval":
      return C.warn("needs approval")
    case "running":
      return C.run("running")
    case "paused":
      return C.warn("paused")
    case "done":
      return C.ok("done")
    case "failed":
      return C.err("failed")
    case "queued":
      return C.muted("queued")
  }
}

/** Step pips: ✓ done, › current, • to do. */
export function pips(steps: Step[]): string {
  if (!steps.length) return ""
  const done = steps.filter((s) => s.state === "done").length
  const p = steps
    .map((s) => (s.state === "done" ? C.ok("✓") : s.state === "doing" ? C.run("›") : C.muted("•")))
    .join("")
  return `${p} ${C.muted(`${done}/${steps.length}`)}`
}

export function currentStep(a: Agent): string {
  const s = a.steps.find((x) => x.state === "doing")
  return s?.text ?? ""
}

export function stepLines(steps: Step[], w: number): string[] {
  return steps.map((s) => {
    const g = s.state === "done" ? C.ok("✓") : s.state === "doing" ? C.run("›") : C.muted("•")
    const t = s.state === "todo" ? C.muted(s.text) : s.state === "doing" ? bold(s.text) : s.text
    return fit(`${g} ${t}`, w)
  })
}

export function fileStats(a: Agent): string {
  if (!a.files.length) return C.muted("no changes")
  const add = a.files.reduce((s, f) => s + f.add, 0)
  const del = a.files.reduce((s, f) => s + f.del, 0)
  return `${a.files.length} file${a.files.length > 1 ? "s" : ""} ${C.add(`+${add}`)} ${C.del(`-${del}`)}`
}

export function fileRows(files: FileChange[], w: number): string[] {
  const nums = (f: FileChange) => `${C.add(`+${f.add}`.padStart(4))} ${C.del(`-${f.del}`.padStart(3))}`
  return files.map((f) => lr(`${C.ok("+")} ${f.path}`, nums(f), w))
}

export function diffLines(files: FileChange[], w: number): string[] {
  const out: string[] = []
  for (const f of files) {
    out.push(C.title(fit(`${f.path}  ${C.add(`+${f.add}`)} ${C.del(`-${f.del}`)}`, w)))
    for (const l of f.diff) {
      const t = truncateToWidth(l, w, "…")
      out.push(
        l.startsWith("@@")
          ? C.hunk(t)
          : l.startsWith("+")
            ? C.add(t)
            : l.startsWith("-")
              ? C.del(t)
              : C.muted(t),
      )
    }
    out.push("")
  }
  if (!out.length) out.push(C.muted("No changes yet."))
  return out
}

export function logLines(run: Run, a: Agent, w: number, withTime = true): string[] {
  const out: string[] = []
  const pre = (l: LogLine) => (withTime ? `${C.muted(clock(l.at))} ` : "")
  const tw = w - (withTime ? 9 : 0)
  for (const l of a.logs) {
    const p = pre(l)
    const pad = withTime ? "         " : ""
    switch (l.kind) {
      case "tool":
        out.push(p + fit(`${C.run("●")} ${bold(l.text)}`, tw))
        break
      case "out":
        out.push(pad + fit(`${C.muted("│")} ${l.text}`, tw))
        break
      case "edit":
        out.push(p + fit(`${C.accent("±")} ${l.text}`, tw))
        break
      case "think":
        for (const [i, row] of wrap(l.text, tw - 2).entries()) out.push((i ? pad : p) + `  ${C.think(row)}`)
        break
      case "user":
        out.push(p + fit(C.user(`› ${l.text}`), tw))
        break
      case "say":
        out.push(p + fit(C.accent(l.text), tw))
        break
      case "err":
        out.push(p + fit(C.err(`✗ ${l.text}`), tw))
        break
      case "sys":
        out.push(p + fit(C.warn(l.text), tw))
        break
    }
  }
  if (a.partial) {
    const shown = a.partial.text.slice(0, Math.floor(a.partial.shown))
    const rows = wrap(`${shown}▍`, tw - 2)
    for (const [i, row] of rows.entries())
      out.push((i ? "         " : withTime ? `${C.muted(clock(run.clock))} ` : "") + `  ${C.think(row)}`)
  }
  if (!out.length) out.push(C.muted(a.status === "queued" ? "Waiting for a free slot…" : "No output yet."))
  return out
}
