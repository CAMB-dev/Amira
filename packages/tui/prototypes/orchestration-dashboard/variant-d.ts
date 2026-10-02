// PROTOTYPE — not production. Variant D: Variant A's look with more room. Same top bar, time
// column, rail, cards and actions, but a blank rail line between phases and between agent cards,
// a short preview instead of the tabbed panel, and Enter opens a full-screen page for an agent.
import { bold, type KeyEvent } from "@amira/tui-kit"
import {
  type App,
  children,
  inputText,
  keepVisible,
  region,
  runOf,
  selectedAgent,
  topBar,
  type Variant,
  viewport,
} from "./app.ts"
import { type Agent, type Phase, phaseAgents, type Run } from "./sim.ts"
import {
  C,
  clock,
  cost,
  currentStep,
  dur,
  fileRows,
  fileStats,
  fit,
  glyph,
  lr,
  phaseGlyph,
  pips,
  statusWord,
  tok,
  vw,
} from "./ui.ts"

const RAIL = "         " // under the time column

function phaseLabel(run: Run, p: Phase): string {
  const n = phaseAgents(run, p.id).length
  if (p.id === "ph:code") return `Code Agent ×${n}`
  if (p.id === "ph:swarm") return `Swarm ×${n}`
  return p.name
}

function phaseDetail(run: Run, p: Phase): string {
  const as = phaseAgents(run, p.id)
  if (p.id === "ph:request") return run.request
  if (p.status === "waiting") return C.muted(p.id === "ph:complete" ? "waiting" : "queued")
  const took = dur((p.endedAt ?? run.clock) - (p.startedAt ?? 0))
  if (p.status === "running") {
    const lead = as.find((a) => a.status === "running") ?? as[0]
    const what = lead ? (as.length > 1 ? run.request : lead.summary) : "finishing"
    return `${what}  ${C.run(`[running ${took}]`)}`
  }
  if (p.id === "ph:complete") return C.ok("All phases done")
  const files = as.reduce((s, a) => s + a.files.length, 0)
  const steps = as.reduce((s, a) => s + a.steps.length, 0)
  const bits = [
    `${steps} steps`,
    `${as.length} agent${as.length > 1 ? "s" : ""}`,
    files ? `${files} files` : "",
    took,
  ]
  return C.muted(bits.filter(Boolean).join(" · ")) + (p.status === "failed" ? C.err("  failed") : "")
}

interface Row {
  line: string
  id?: string
}

function cardRows(app: App, a: Agent, last: boolean, w: number, depth: number, roomy: boolean): Row[] {
  const run = runOf(app)
  const sel = app.sel[app.data] === a.id
  const open = sel || app.expanded.has(a.id)
  const branch = depth === 0 ? (last ? "└─" : "├─") : last ? "└" : "├"
  const indent = depth === 0 ? `${RAIL}` : `${RAIL}│   `
  const cont = depth === 0 ? `${RAIL}${last ? " " : "│"}    ` : `${RAIL}│   ${last ? " " : "│"} `
  const pointer = sel ? C.run("▶") : open ? C.muted("▾") : C.muted("▸")
  const tag = a.tag ? C.tag(`[${a.tag}]`) : ""
  const k = (key: string, label: string) => `${sel ? C.run(key) : C.muted(key)} ${C.muted(label)}`
  const canPause = a.status === "running" || a.status === "paused" || a.status === "approval"
  const acts =
    w >= 110 && depth === 0
      ? [
          a.files.length ? k("o", "diff") : "",
          canPause ? k("p", a.status === "paused" ? "resume" : "pause") : "",
          a.status !== "queued" ? k("r", "changes") : "",
        ]
          .filter(Boolean)
          .join("  ")
      : ""
  const head = `${indent}${C.border(branch)}${pointer} ${glyph(a.status, app.now)} ${bold(a.name.padEnd(10))} ${fit(
    a.task,
    Math.min(24, Math.max(10, w - 90)),
  )} ${tag}  ${a.status === "queued" ? C.muted("queued") : pips(a.steps)}   ${fileStats(a)}`
  const rows: Row[] = [{ line: lr(head, acts, w), id: a.id }]
  const sub = (s: string) => rows.push({ line: fit(`${C.border(cont)}${s}`, w) })
  if (a.status === "approval") sub(C.warn(`? needs approval: ${a.approval}  — a approve · x deny`))
  if (open) {
    sub(C.muted(a.summary))
    const now = currentStep(a)
    if (now || a.tool) sub(`${now ? `${C.run("›")} ${now}` : ""}${a.tool ? C.muted(`   ● ${a.tool}`) : ""}`)
    if (a.files.length && roomy) {
      sub(C.muted("Changed files"))
      for (const f of fileRows(a.files, Math.min(60, w - vw(cont)))) sub(f)
    }
  } else if (a.status !== "queued") {
    const said = run.msgs.filter((m) => m.from === a.name).at(-1)
    const line =
      run.kind === "swarm" && said
        ? `${C.accent(`→@${said.to}`)} ${said.text}`
        : a.status === "done"
          ? C.muted(`done in ${dur((a.endedAt ?? 0) - (a.startedAt ?? 0))}`)
          : `${C.run("›")} ${currentStep(a)}${a.tool ? C.muted(`   ● ${a.tool}`) : ""}`
    sub(line)
  }
  const kids = children(run, a.id)
  if (kids.length && (open || kids.some((k) => k.status === "running"))) {
    kids.forEach((k, i) => rows.push(...cardRows(app, k, i === kids.length - 1, w, depth + 1, roomy)))
  }
  // Room between cards: an empty line that keeps the tree's lines going.
  if (depth === 0 && !last) rows.push({ line: C.border(`${RAIL}│`) })
  return rows
}

function timeline(app: App, w: number, roomy = true): Row[] {
  const run = runOf(app)
  const rows: Row[] = []
  run.phases.forEach((p, i) => {
    const open = app.expanded.has(p.id)
    const as = phaseAgents(run, p.id)
    const t = p.startedAt !== undefined ? C.muted(clock(p.startedAt)) : C.muted("  ·  ·  ")
    const arrow = as.length ? (open ? "▾" : "▸") : " "
    const sel = app.sel[app.data] === p.id
    const name =
      p.status === "running" ? C.run(bold(fit(phaseLabel(run, p), 15))) : bold(fit(phaseLabel(run, p), 15))
    const head = `${t} ${phaseGlyph(p, app.now)} ${sel ? C.run("▶") : " "}${name} ${phaseDetail(run, p)}`
    rows.push({ line: lr(head, C.muted(`${p.ref} ${arrow}`), w), id: p.id })
    if (open) as.forEach((a, j) => rows.push(...cardRows(app, a, j === as.length - 1, w, 0, roomy)))
    if (i < run.phases.length - 1) rows.push({ line: `${RAIL}${C.border("│")}` })
  })
  return rows
}

/** A few lines about the selection; Enter opens the full-screen page for an agent. */
function preview(app: App, w: number, h: number): string[] {
  const run = runOf(app)
  const a = selectedAgent(app)
  const ph = run.phases.find((p) => p.id === app.sel[app.data])
  const lines: string[] = []
  if (a) {
    lines.push(
      lr(
        `  ${glyph(a.status, app.now)} ${bold(a.name)}   ${C.muted(a.task)}`,
        `${statusWord(a)}   ${C.muted(`${tok(a.tokens)} tok · ${cost(a.cost)}`)}  `,
        w,
      ),
    )
    lines.push(`  ${C.muted(fit(a.summary, w - 4))}`)
    const now = currentStep(a)
    if (now) lines.push(`  ${C.run("›")} ${fit(now, w - 6)}${a.tool ? C.muted(`   ● ${a.tool}`) : ""}`)
  } else if (ph) {
    lines.push(`  ${phaseGlyph(ph, app.now)} ${bold(ph.name)}   ${phaseDetail(run, ph)}`)
  }
  while (lines.length < h) lines.push("")
  return lines.slice(0, h)
}

function render(app: App, w: number, h: number): string[] {
  const out = [topBar(app, w), C.border("─".repeat(w)), ""]
  const previewH = 4
  const tlH = Math.max(3, h - out.length - previewH - 3)
  const rows = timeline(app, w, true)
  const lines = rows.map((r) => (r.id && r.id === app.sel[app.data] ? C.sel(fit(r.line, w)) : r.line))
  const idx = rows.findIndex((r) => r.id === app.sel[app.data])
  if (idx >= 0) keepVisible(app, "d.tl", idx, tlH)
  region(app, "d.tl", 0, out.length, w, tlH)
  out.push(...viewport(app, "d.tl", lines, tlH))
  out.push(C.border("─".repeat(w)))
  out.push(...preview(app, w, previewH))
  out.push(C.border("─".repeat(w)))
  out.push(
    lr(
      ` ${inputText(app, w - 30)}`,
      `${C.run("Enter")} ${C.muted("open")}   ${C.run("→")} ${C.muted("expand")} `,
      w,
    ),
  )
  return out.slice(0, h)
}

function ids(app: App, w: number): string[] {
  return timeline(app, w)
    .map((r) => r.id)
    .filter((x): x is string => !!x)
}

function key(app: App, e: KeyEvent): boolean {
  const run = runOf(app)
  const list = ids(app, 120)
  const cur = app.sel[app.data]
  const i = Math.max(0, list.indexOf(cur))
  const isPhase = cur.startsWith("ph:")
  switch (e.name) {
    case "up":
    case "k":
      app.sel[app.data] = list[Math.max(0, i - 1)]!
      app.scroll["d.tl"] = 0
      return true
    case "down":
    case "j":
      app.sel[app.data] = list[Math.min(list.length - 1, i + 1)]!
      app.scroll["d.tl"] = 0
      return true
    case "enter":
      if (!isPhase) {
        app.overlay = { kind: "page", id: cur }
        app.tab = 0
        app.scroll.page = 0
        return true
      }
    // falls through: Enter on a phase expands or folds it, as → does
    case "right":
      if (isPhase) {
        if (app.expanded.has(cur) && e.name === "enter") {
          app.expanded.delete(cur)
          app.collapsed.add(cur)
        } else {
          app.expanded.add(cur)
          app.collapsed.delete(cur)
        }
      } else if (app.expanded.has(cur) && e.name === "enter") app.expanded.delete(cur)
      else app.expanded.add(cur)
      return true
    case "left": {
      if (isPhase) {
        app.expanded.delete(cur)
        app.collapsed.add(cur)
        return true
      }
      const a = run.agents.find((x) => x.id === cur)
      if (a) app.sel[app.data] = a.parent ?? a.phase
      return true
    }
  }
  return false
}

export const variantD: Variant = {
  name: "Timeline (roomy)",
  mainScroll: "d.tl",
  mainTail: false,
  render,
  key,
}
