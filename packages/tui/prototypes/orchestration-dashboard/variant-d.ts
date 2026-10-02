// PROTOTYPE — not production. Variant D: Variant A with room to breathe. Same timeline idea,
// but a two-line header, blank lines between phases, no reference ids or rail lines, one line per
// collapsed agent, at most two detail lines for the selected one, actions only in the footer,
// a smaller two-column detail panel and a one-line input.
import { bold, type KeyEvent } from "@amira/tui-kit"
import {
  type App,
  children,
  inputText,
  keepVisible,
  region,
  runOf,
  selectedAgent,
  type Variant,
  viewport,
} from "./app.ts"
import { type Agent, type Phase, phaseAgents, type Run } from "./sim.ts"
import {
  C,
  cost,
  currentPhase,
  currentStep,
  dur,
  fit,
  glyph,
  lr,
  phaseGlyph,
  pips,
  statusWord,
  tok,
  totals,
} from "./ui.ts"

const GAP = "   "

function header(app: App, w: number): string[] {
  const run = runOf(app)
  const t = totals(run)
  const title = ` ${C.accent(bold("amira"))}  ${bold(run.title)}  ${C.muted(run.kind)}`
  const stats = [
    `${C.muted("phase")} ${C.run(currentPhase(run).name.toLowerCase())}`,
    `${C.muted("running")} ${C.run(`${t.running}/${t.total}`)}`,
    ...(t.approvals ? [C.warn(bold(`${t.approvals} waiting for you`))] : []),
    `${C.muted("cost")} ${cost(t.cost)}`,
    `${C.muted("tokens")} ${tok(t.tokens)}`,
    `${C.muted("elapsed")} ${dur(run.clock)}`,
  ]
  return [fit(title, w), fit(` ${stats.join(GAP)}`, w), ""]
}

function phaseName(run: Run, p: Phase): string {
  const n = phaseAgents(run, p.id).length
  if (p.id === "ph:code") return `Code · ${n} agents`
  if (p.id === "ph:swarm") return `Swarm · ${n} members`
  return p.name
}

function phaseNote(run: Run, p: Phase): string {
  if (p.id === "ph:request") return C.muted(fit(run.request, 60))
  if (p.status === "waiting") return C.muted("waiting")
  const took = dur((p.endedAt ?? run.clock) - (p.startedAt ?? 0))
  if (p.status === "running") return C.run(took)
  if (p.status === "failed") return C.err(`failed after ${took}`)
  return C.muted(took)
}

interface Row {
  line: string
  id?: string
}

function agentRows(app: App, a: Agent, last: boolean, w: number, prefix: string): Row[] {
  const run = runOf(app)
  const sel = app.sel[app.data] === a.id
  const open = sel || app.expanded.has(a.id)
  const branch = C.border(last ? "└─ " : "├─ ")
  const cont = `${prefix}${C.border(last ? "   " : "│  ")}`
  const time = a.startedAt === undefined ? "" : dur((a.endedAt ?? run.clock) - a.startedAt)
  const progress = a.status === "queued" ? C.muted("queued") : pips(a.steps)
  const left = `${prefix}${branch}${glyph(a.status, app.now)}  ${bold(a.name)}${GAP}${fit(a.task, Math.max(12, w - 60))}`
  const right = `${progress}${GAP}${C.muted(time)} `
  const rows: Row[] = [{ line: lr(left, right, w), id: a.id }]
  const sub = (s: string) => rows.push({ line: fit(`${cont}   ${s}`, w) })
  if (a.status === "approval") sub(C.warn(`waiting for approval: ${a.approval}`))
  if (open) {
    const now = currentStep(a)
    if (now) sub(`${C.run("›")} ${now}`)
    const files = a.files.length
    const changed = files ? `${files} file${files > 1 ? "s" : ""} changed` : ""
    sub(C.muted([a.tool, changed].filter(Boolean).join(" · ") || statusWord(a)))
  }
  const kids = children(run, a.id)
  if (kids.length && (open || kids.some((k) => k.status === "running"))) {
    kids.forEach((k, i) => rows.push(...agentRows(app, k, i === kids.length - 1, w, cont)))
  }
  return rows
}

const RAIL = "    " // phases' left rail sits under the glyph column

function timeline(app: App, w: number): Row[] {
  const run = runOf(app)
  const rows: Row[] = []
  run.phases.forEach((p, i) => {
    const lastPhase = i === run.phases.length - 1
    const open = app.expanded.has(p.id)
    const as = phaseAgents(run, p.id)
    const sel = app.sel[app.data] === p.id
    const name = p.status === "running" ? C.run(bold(phaseName(run, p))) : bold(phaseName(run, p))
    const fold = as.length ? C.muted(open ? "  ▾" : "  ▸") : ""
    rows.push({
      line: lr(` ${phaseGlyph(p, app.now)}  ${name}${fold}`, `${phaseNote(run, p)} `, w),
      id: p.id,
    })
    const rail = lastPhase ? " " : C.border("│")
    if (sel && !open && as.length)
      rows.push({ line: ` ${rail}  ${C.muted(`${as.length} inside · → to expand`)}` })
    if (open) as.forEach((a, j) => rows.push(...agentRows(app, a, j === as.length - 1, w, ` ${rail}  `)))
    if (!lastPhase) rows.push({ line: ` ${C.border("│")}` })
  })
  return rows
}

/** A few lines about the selection; Enter opens the full-screen page for an agent. */
function preview(app: App, a: Agent | undefined, ph: Phase | undefined, w: number, h: number): string[] {
  const run = runOf(app)
  const lines: string[] = []
  if (a) {
    lines.push(
      lr(
        `  ${glyph(a.status, app.now)} ${bold(a.name)}   ${C.muted(a.task)}`,
        `${statusWord(a)}   ${tok(a.tokens)} tok · ${cost(a.cost)}  `,
        w,
      ),
    )
    lines.push(`  ${C.muted(fit(a.summary, w - 4))}`)
    const now = currentStep(a)
    if (now) lines.push(`  ${C.run("›")} ${fit(now, w - 6)}`)
  } else if (ph) {
    const as = phaseAgents(run, ph.id)
    lines.push(
      `  ${phaseGlyph(ph, app.now)} ${bold(ph.name)}   ${C.muted(`${as.length} agent${as.length === 1 ? "" : "s"}`)}`,
    )
  }
  while (lines.length < h) lines.push("")
  return lines.slice(0, h)
}

function render(app: App, w: number, h: number): string[] {
  const run = runOf(app)
  const out = header(app, w)
  const panelH = 5
  const tlH = Math.max(3, h - out.length - panelH - 3)
  const rows = timeline(app, w)
  const lines = rows.map((r) => (r.id && r.id === app.sel[app.data] ? C.sel(fit(r.line, w)) : r.line))
  const idx = rows.findIndex((r) => r.id === app.sel[app.data])
  if (idx >= 0) keepVisible(app, "d.tl", idx, tlH)
  region(app, "d.tl", 0, out.length, w, tlH)
  out.push(...viewport(app, "d.tl", lines, tlH))

  const a = selectedAgent(app)
  const ph = run.phases.find((p) => p.id === app.sel[app.data])
  out.push(C.border("─".repeat(w)))
  out.push(...preview(app, a, ph, w, panelH - 1))
  const keys = a
    ? `${C.run("Enter")} ${C.muted("open")}${GAP}${C.run("o")} ${C.muted("diff")}${GAP}${C.run("p")} ${C.muted("pause")}${GAP}${C.run("r")} ${C.muted("changes")}${a.status === "approval" ? `${GAP}${C.run("a/x")} ${C.muted("approve/deny")}` : ""}`
    : `${C.run("→")} ${C.muted("expand")}`
  out.push(C.border("─".repeat(w)))
  out.push(lr(` ${inputText(app, w - 40)}`, `${keys} `, w))
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
      app.scroll["d.panel"] = 0
      return true
    case "down":
    case "j":
      app.sel[app.data] = list[Math.min(list.length - 1, i + 1)]!
      app.scroll["d.panel"] = 0
      return true
    case "enter":
      if (!isPhase) {
        app.overlay = { kind: "page", id: cur }
        app.tab = 0
        app.scroll.page = 0
        return true
      }
      if (app.expanded.has(cur)) {
        app.expanded.delete(cur)
        app.collapsed.add(cur)
      } else {
        app.expanded.add(cur)
        app.collapsed.delete(cur)
      }
      return true
    case "right":
      if (app.expanded.has(cur) && e.name === "enter") {
        app.expanded.delete(cur)
        if (isPhase) app.collapsed.add(cur)
      } else {
        app.expanded.add(cur)
        if (isPhase) app.collapsed.delete(cur)
      }
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
  mainScroll: "d.panel",
  mainTail: true,
  render,
  key,
}
