// PROTOTYPE — not production. Variant D: the original mockup, drawn as close to it as a terminal
// allows, with its room. Top bar with help on the right; a timeline whose rows carry the time, a
// status mark and a node on a rail, each row underlined; an open phase shows a box of worker cards
// (tag, progress bar, changed files, Open diff / Pause / Request changes) joined to the rail; the
// tabbed detail panel below; a framed input. Enter on an agent opens a full-screen page.
import { bg256, bold, compose, fg256, type KeyEvent } from "@amira/tui-kit"
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
  type Variant,
  viewport,
} from "./app.ts"
import { type Agent, type Phase, phaseAgents, type Run } from "./sim.ts"
import { C, clock, cost, currentPhase, dur, fileRows, fit, frame, glyph, lr, totals } from "./ui.ts"

const TIME_W = 10 // "10:12:31  "
const MARK_W = 3 // "✓  "
const NODE_W = 3 // "○  "
const NAME_W = 16
const LEFT = 1 + TIME_W + MARK_W + NODE_W // where names and the cards' box start

type Line = { line: string; id?: string; head?: boolean }

function topBar(app: App, w: number): string {
  const run = runOf(app)
  const t = totals(run)
  const sep = C.border("  │  ")
  const left = [
    C.run(bold("amira")),
    `${C.muted("workspace:")} ${run.workspace}`,
    `${C.muted("phase:")} ${C.run(currentPhase(run).name.toLowerCase())}`,
    `${C.muted("running:")} ${C.run(`${t.running}/${t.total}`)}`,
    ...(t.approvals ? [C.warn(bold(`${t.approvals} waiting for you`))] : []),
    `${C.muted("cost:")} ${cost(t.cost)}`,
  ].join(sep)
  const right = [`ctrl+k ${C.muted("help")}`, `? ${C.muted("shortcuts")}`, `q ${C.muted("quit")}`].join(sep)
  return lr(` ${left}`, `${right} `, w)
}

function phaseLabel(run: Run, p: Phase): string {
  const n = phaseAgents(run, p.id).length
  if (p.id === "ph:code") return `Code Agent ×${n}`
  if (p.id === "ph:swarm") return `Swarm ×${n}`
  return p.name
}

function phaseDesc(run: Run, p: Phase): string {
  const as = phaseAgents(run, p.id)
  if (p.id === "ph:request") return run.request
  if (p.status === "waiting") return C.muted(p.id === "ph:integrate" ? "queued" : "waiting")
  const took = dur((p.endedAt ?? run.clock) - (p.startedAt ?? 0))
  if (p.status === "running") return `${run.request}   ${C.run(`▏running ${took}▕`)}`
  if (p.id === "ph:complete") return C.ok("all phases done")
  const steps = as.reduce((s, a) => s + a.steps.length, 0)
  const bits = [`${steps} steps`, `${as.length} agent${as.length === 1 ? "" : "s"}`, took]
  return C.muted(bits.join("  ·  ")) + (p.status === "failed" ? C.err("   failed") : "")
}

function mark(p: Phase, now: number): string {
  if (p.status === "done") return C.ok("✓")
  if (p.status === "failed") return C.err("✗")
  if (p.status === "running") return glyph("running", now)
  return " "
}

/** A progress bar from the agent's steps (a step in progress counts half). */
function bar(a: Agent, width = 14): string {
  const total = a.steps.length || 1
  const doing = a.steps.filter((s) => s.state === "doing").length
  const done = a.steps.filter((s) => s.state === "done").length + doing / 2
  const pct = a.status === "done" ? 100 : Math.round((done / total) * 100)
  const full = Math.round((pct / 100) * width)
  return `${C.ok("━".repeat(full))}${C.border("━".repeat(width - full))}  ${C.muted(`${pct}%`.padStart(4))}`
}

/** Ways to mark an agent's language without a box; `t` cycles them to compare. */
const TAG_STYLES = ["pill", "chip", "text", "brackets"] as const
let tagStyle = 0
const TAG_COLORS: Record<string, number> = {
  TypeScript: 24,
  PostgreSQL: 23,
  Markdown: 239,
  Rust: 94,
  Python: 58,
}

function tagLabel(tag: string): string {
  const c = TAG_COLORS[tag] ?? 60
  switch (TAG_STYLES[tagStyle]) {
    case "pill":
      // Half blocks in the chip's colour round its ends off.
      return `${fg256(c)("▐")}${compose(bg256(c), fg256(255))(tag)}${fg256(c)("▌")}`
    case "chip":
      return compose(bg256(c), fg256(255))(` ${tag} `)
    case "text":
      return fg256(c === 239 ? 250 : c + 87)(tag)
    default:
      return C.tag(`[${tag}]`)
  }
}

function card(app: App, a: Agent, w: number, nested = false): Line[] {
  const run = runOf(app)
  const sel = app.sel[app.data] === a.id
  const pad = nested ? "    " : ""
  const files = a.files.length
  const changed = files
    ? `${files} file${files > 1 ? "s" : ""} changed ${C.muted("▸")}`
    : C.muted("no changes")
  const canPause = a.status === "running" || a.status === "paused" || a.status === "approval"
  const acts = [
    files ? C.run("Open diff") : "",
    canPause ? (a.status === "paused" ? "Resume" : "Pause") : "",
    a.status !== "queued" ? "Request changes" : "",
  ]
    .filter(Boolean)
    .join("   ")
  const progress = a.status === "queued" ? C.muted("queued".padEnd(20)) : bar(a)
  const tag = a.tag ? tagLabel(a.tag) : ""
  const name = sel ? C.sel(bold(a.name.padEnd(10))) : bold(a.name.padEnd(10))
  const left = `${pad}${glyph(a.status, app.now)} ${name}  ${fit(a.task, 22)}  ${fit(tag, 14)}  ${progress}`
  const right = `${changed}  ${C.border("│")}  ${acts}  ${C.muted("⋮")}`
  const out: Line[] = [{ line: lr(left, right, w), id: a.id, head: !nested }]
  const sub = (s: string) => out.push({ line: fit(`${pad}  ${s}`, w) })
  if (a.status === "approval") sub(C.warn(`? needs approval: ${a.approval}   a approve · x deny`))
  sub(C.muted(a.summary))
  if (a.status === "done") sub(C.muted(`done in ${dur((a.endedAt ?? 0) - (a.startedAt ?? 0))}`))
  if (files && !nested) {
    out.push({ line: "" })
    sub(C.muted("Changed files"))
    for (const f of fileRows(a.files, Math.min(52, w - 8))) sub(f)
  }
  if (run.kind === "swarm") {
    const said = run.msgs.filter((m) => m.from === a.name).at(-1)
    if (said) sub(`${C.accent(`→ @${said.to}`)} ${said.text}`)
  }
  return out
}

/** The box of worker cards under an open phase, joined to the rail on the left. */
function cards(app: App, p: Phase, w: number, railBelow: boolean): Line[] {
  const run = runOf(app)
  const as = phaseAgents(run, p.id).filter((a) => !a.parent)
  if (!as.length) return []
  const boxW = w - LEFT - 1
  const inner = boxW - 4
  const body: Line[] = []
  as.forEach((a, i) => {
    if (i > 0) body.push({ line: C.border("─".repeat(inner)) })
    body.push(...card(app, a, inner))
    for (const k of children(run, a.id)) body.push(...card(app, k, inner, true))
  })
  body.push({ line: "" })
  const keys = [
    `↑/k ${C.muted("prev")}`,
    `↓/j ${C.muted("next")}`,
    `Enter ${C.muted("open")}`,
    `o ${C.muted("open all diffs")}`,
    `p ${C.muted("pause all")}`,
    `t ${C.muted(`tag: ${TAG_STYLES[tagStyle]}`)}`,
  ].join("    ")
  body.push({ line: lr(`${C.run("Add worker")}  ${C.muted("(max 4)")}`, keys, inner) })
  const boxed = frame(
    body.map((b) => ` ${b.line} `),
    boxW,
    body.length + 2,
  )
  const heads = body.flatMap((b, i) => (b.head ? [i + 1] : []))
  const lastHead = heads.at(-1) ?? 0
  const railPad = " ".repeat(1 + TIME_W + MARK_W)
  return boxed.map((line, i) => {
    const isHead = heads.includes(i)
    const conn = isHead
      ? C.border(i === lastHead && !railBelow ? "└──" : "├──")
      : C.border(i < lastHead || railBelow ? "│  " : "   ")
    // A card's first line starts with an arrow where the box's left edge is.
    const l = isHead ? C.border("▶") + line.slice(line.indexOf("│") + 1) : line
    return { line: `${railPad}${conn}${l}`, id: isHead ? body[i - 1]?.id : undefined }
  })
}

function timeline(app: App, w: number): Line[] {
  const run = runOf(app)
  const rows: Line[] = []
  run.phases.forEach((p, i) => {
    const last = i === run.phases.length - 1
    const open = app.expanded.has(p.id)
    const sel = app.sel[app.data] === p.id
    const as = phaseAgents(run, p.id)
    const time = clock(p.startedAt ?? run.clock)
    const label = fit(phaseLabel(run, p), NAME_W)
    const name = p.status === "running" ? C.run(bold(label)) : bold(label)
    const nodeCh = p.status === "running" ? C.run("◉") : C.muted("○")
    const head = `${C.muted(time.padEnd(TIME_W))}${fit(mark(p, app.now), MARK_W)}${fit(nodeCh, NODE_W)}${sel ? C.sel(name) : name}${phaseDesc(run, p)}`
    const arrow = as.length && open ? "▾" : "▸"
    rows.push({ line: lr(` ${head}`, `${C.muted(p.ref)}  ${arrow} `, w), id: p.id })
    if (open && as.length) rows.push(...cards(app, p, w, !last))
    // Every row is underlined, the rail running through the gap.
    const railCh = last ? " " : C.border("│")
    rows.push({
      line: `${" ".repeat(1 + TIME_W + MARK_W)}${railCh}${" ".repeat(NODE_W - 1)}${C.border("─".repeat(Math.max(0, w - LEFT - 1)))}`,
    })
  })
  return rows
}

function detailPanel(app: App, w: number, h: number): string[] {
  const run = runOf(app)
  const a = selectedAgent(app)
  const ph = run.phases.find((p) => p.id === app.sel[app.data])
  const handle = Math.floor((w - 3) / 2)
  const out = [C.border("─".repeat(handle)) + C.muted(" ≡ ") + C.border("─".repeat(w - handle - 3))]
  const tabs = TABS.map((t, i) =>
    i === app.tab ? C.sel(C.run(bold(`  ${t}  `))) : C.muted(`  ${t}  `),
  ).join(C.border("│"))
  const title = a
    ? `${a.name}  ${C.muted(a.task)}   ${C.muted("✕")} `
    : ph
      ? `${ph.name}   ${C.muted("✕")} `
      : ""
  out.push(lr(` ${tabs}`, title, w))
  out.push(C.border("─".repeat(w)))
  const ch = Math.max(1, h - out.length - 1)
  const tail = TABS[app.tab] === "Logs"
  const body = a ? detailTab(app, a, w - 4) : ph ? phaseLines(app, ph, w - 4) : [C.muted("Nothing selected")]
  region(app, "d.panel", 2, 0, w - 4, ch, tail)
  out.push(...viewport(app, "d.panel", body, ch, tail).map((l) => `  ${l}`))
  out.push(
    lr(
      ` Enter ${C.muted("open")}   o ${C.muted("open diff")}   p ${C.muted("pause")}   r ${C.muted("request changes")}   esc ${C.muted("close")}`,
      `Tab ${C.muted("next tab")}   Shift+Tab ${C.muted("previous tab")} `,
      w,
    ),
  )
  return out
}

function render(app: App, w: number, h: number): string[] {
  const out = [topBar(app, w), C.border("─".repeat(w))]
  const inputH = 3
  const panelH = Math.max(9, Math.min(15, Math.round(h * 0.36)))
  const tlH = Math.max(4, h - out.length - panelH - inputH)
  const rows = timeline(app, w)
  const idx = rows.findIndex((r) => r.id === app.sel[app.data])
  if (idx >= 0) keepVisible(app, "d.tl", idx, tlH)
  region(app, "d.tl", 0, out.length, w, tlH)
  out.push(
    ...viewport(
      app,
      "d.tl",
      rows.map((r) => r.line),
      tlH,
    ),
  )
  out.push(...detailPanel(app, w, panelH))
  const hint = app.inputOn
    ? inputText(app, w - 40)
    : `${C.run(">")} ${C.muted("Ask Amira or enter a command...")}`
  const keys = `Enter ${C.muted("send")}  ·  Shift+Enter ${C.muted("newline")} `
  out.push(...frame([lr(` ${hint}`, keys, w - 2)], w, inputH, { color: C.focusBorder }))
  return out.slice(0, h)
}

function ids(app: App, w: number): string[] {
  return timeline(app, w).flatMap((r) => (r.id ? [r.id] : []))
}

function toggle(app: App, id: string, open?: boolean) {
  if (open ?? !app.expanded.has(id)) {
    app.expanded.add(id)
    app.collapsed.delete(id)
  } else {
    app.expanded.delete(id)
    app.collapsed.add(id)
  }
}

function key(app: App, e: KeyEvent): boolean {
  const run = runOf(app)
  const list = ids(app, 160)
  const cur = app.sel[app.data]
  const i = Math.max(0, list.indexOf(cur))
  const isPhase = cur.startsWith("ph:")
  switch (e.name) {
    case "t":
      tagStyle = (tagStyle + 1) % TAG_STYLES.length
      return true
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
      } else toggle(app, cur)
      return true
    case "right":
      if (isPhase) toggle(app, cur, true)
      return true
    case "left": {
      if (isPhase) {
        toggle(app, cur, false)
        return true
      }
      const a = run.agents.find((x) => x.id === cur)
      if (a) app.sel[app.data] = a.parent ?? a.phase
      return true
    }
  }
  return false
}

export const variantD: Variant = { name: "Mockup", mainScroll: "d.panel", mainTail: true, render, key }
