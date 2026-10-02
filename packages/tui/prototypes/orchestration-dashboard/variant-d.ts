// PROTOTYPE — not production. Variant D: Variant A with room to breathe. Same timeline idea,
// but a two-line header, blank lines between phases, no reference ids or rail lines, one line per
// collapsed agent, at most two detail lines for the selected one, actions only in the footer,
// a smaller two-column detail panel and a one-line input.
import { bold, type KeyEvent } from "@amira/tui-kit"
import {
  type App,
  children,
  detailTab,
  inputText,
  keepVisible,
  phaseLines,
  region,
  runOf,
  selectedAgent,
  TABS,
  tabsRow,
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

function agentRows(app: App, a: Agent, w: number, depth: number): Row[] {
  const run = runOf(app)
  const sel = app.sel[app.data] === a.id
  const open = sel || app.expanded.has(a.id)
  const pad = "    ".repeat(depth + 1)
  const time = a.startedAt === undefined ? "" : dur((a.endedAt ?? run.clock) - a.startedAt)
  const progress = a.status === "queued" ? C.muted("queued") : pips(a.steps)
  const left = `${pad}${glyph(a.status, app.now)}  ${bold(a.name)}${GAP}${fit(a.task, Math.max(12, w - 60))}`
  const right = `${progress}${GAP}${C.muted(time)} `
  const rows: Row[] = [{ line: lr(left, right, w), id: a.id }]
  const sub = (s: string) => rows.push({ line: fit(`${pad}   ${s}`, w) })
  if (a.status === "approval") sub(C.warn(`waiting for approval: ${a.approval}`))
  if (open) {
    const now = currentStep(a)
    if (now) sub(`${C.run("›")} ${now}`)
    const files = a.files.length
    sub(
      C.muted(
        a.tool
          ? `${a.tool}${files ? ` · ${files} file${files > 1 ? "s" : ""} changed` : ""}`
          : files
            ? `${files} file${files > 1 ? "s" : ""} changed`
            : statusWord(a),
      ),
    )
  }
  const kids = children(run, a.id)
  if (kids.length && (open || kids.some((k) => k.status === "running"))) {
    for (const k of kids) rows.push(...agentRows(app, k, w, depth + 1))
  }
  return rows
}

function timeline(app: App, w: number): Row[] {
  const run = runOf(app)
  const rows: Row[] = []
  run.phases.forEach((p, i) => {
    if (i > 0) rows.push({ line: "" })
    const open = app.expanded.has(p.id)
    const as = phaseAgents(run, p.id)
    const sel = app.sel[app.data] === p.id
    const name = p.status === "running" ? C.run(bold(phaseName(run, p))) : bold(phaseName(run, p))
    const fold = as.length ? C.muted(open ? "  ▾" : "  ▸") : ""
    rows.push({
      line: lr(` ${phaseGlyph(p, app.now)}  ${name}${fold}`, `${phaseNote(run, p)} `, w),
      id: p.id,
    })
    if (sel && !open && as.length) rows.push({ line: C.muted(`     ${as.length} inside · Enter to open`) })
    if (open) for (const a of as) rows.push(...agentRows(app, a, w, 0))
  })
  return rows
}

function render(app: App, w: number, h: number): string[] {
  const run = runOf(app)
  const out = header(app, w)
  const panelH = Math.max(7, Math.min(12, Math.round(h * 0.34)))
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
  const title = a ? `${glyph(a.status, app.now)} ${bold(a.name)} ` : ph ? `${bold(ph.name)} ` : ""
  out.push(tabsRow(app, w, title))
  const ch = panelH - 2
  const tail = TABS[app.tab] === "Logs"
  const body = a
    ? detailTab(app, a, Math.min(w - 4, 96))
    : ph
      ? phaseLines(app, ph, w - 4)
      : [C.muted("Nothing selected")]
  region(app, "d.panel", 2, out.length, w - 4, ch, tail)
  out.push(...viewport(app, "d.panel", body, ch, tail).map((l) => `  ${l}`))

  const keys = a
    ? `${C.run("o")} ${C.muted("diff")}${GAP}${C.run("p")} ${C.muted("pause")}${GAP}${C.run("r")} ${C.muted("changes")}${a.status === "approval" ? `${GAP}${C.run("a/x")} ${C.muted("approve/deny")}` : ""}`
    : `${C.run("Enter")} ${C.muted("open")}`
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
