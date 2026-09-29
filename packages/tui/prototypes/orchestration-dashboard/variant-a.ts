// PROTOTYPE — not production. Variant A: faithful to the mockup. Top bar, a vertical timeline of
// phases whose agent cards expand in place, a tabbed detail panel below, the input box last.
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
  topBar,
  type Variant,
  viewport,
} from "./app.ts"
import { type Agent, type Phase, phaseAgents, type Run } from "./sim.ts"
import {
  C,
  clock,
  currentStep,
  dur,
  fileRows,
  fileStats,
  fit,
  frame,
  glyph,
  lr,
  phaseGlyph,
  pips,
  rule,
  statusWord,
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
    if (i < run.phases.length - 1 && (open || w >= 0)) {
      // The rail between phases; left out when the phase is collapsed to save rows.
      if (open) rows.push({ line: `${RAIL}${C.border("│")}` })
    }
  })
  return rows
}

function render(app: App, w: number, h: number): string[] {
  const run = runOf(app)
  const out = [topBar(app, w), C.border("─".repeat(w))]
  const inputH = 3
  const panelH = Math.max(8, Math.min(16, Math.round(h * 0.42)))
  const tlH = Math.max(3, h - 2 - panelH - inputH)
  const rows = timeline(app, w, tlH >= 14)
  const lines = rows.map((r) => (r.id && r.id === app.sel[app.data] ? C.sel(fit(r.line, w)) : r.line))
  const idx = rows.findIndex((r) => r.id === app.sel[app.data])
  if (idx >= 0) keepVisible(app, "a.tl", idx, tlH)
  region(app, "a.tl", 0, 2, w, tlH)
  out.push(...viewport(app, "a.tl", lines, tlH))

  // Detail panel
  const a = selectedAgent(app)
  const ph = run.phases.find((p) => p.id === app.sel[app.data])
  const handle = Math.floor((w - 3) / 2)
  out.push(C.border("─".repeat(handle)) + C.muted(" ≡ ") + C.border("─".repeat(w - handle - 3)))
  const title = a
    ? `${glyph(a.status, app.now)} ${bold(a.name)}  ${w >= 100 ? `${a.task}  ${statusWord(a)}` : ""}`
    : ph
      ? bold(ph.name)
      : ""
  out.push(tabsRow(app, w, title + " "))
  const ch = panelH - 3
  const tail = TABS[app.tab] === "Logs"
  const body = a ? detailTab(app, a, w - 2) : ph ? phaseLines(app, ph, w - 2) : [C.muted("Nothing selected")]
  region(app, "a.panel", 1, out.length, w - 2, ch, tail)
  out.push(...viewport(app, "a.panel", body, ch, tail).map((l) => ` ${l}`))
  out.push(
    lr(
      ` ${C.run("Enter")} ${C.muted("open")}  ${C.run("o")} ${C.muted("open diff")}  ${C.run("p")} ${C.muted("pause")}  ${C.run("r")} ${C.muted("request changes")}  ${C.run("a/x")} ${C.muted("approve/deny")}`,
      `${C.run("Tab")} ${C.muted("next tab")}  ${C.run("PgUp/PgDn")} ${C.muted("scroll")} `,
      w,
    ),
  )
  // Input
  out.push(
    ...frame([` ${inputText(app, w - 4)}`], w, inputH, {
      color: app.inputOn ? C.focusBorder : C.border,
      right: app.inputOn ? C.muted("Enter send · Esc cancel") : "",
    }),
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
      app.scroll["a.panel"] = 0
      return true
    case "down":
    case "j":
      app.sel[app.data] = list[Math.min(list.length - 1, i + 1)]!
      app.scroll["a.panel"] = 0
      return true
    case "enter":
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

export const variantA: Variant = { name: "Timeline", mainScroll: "a.panel", mainTail: true, render, key }
