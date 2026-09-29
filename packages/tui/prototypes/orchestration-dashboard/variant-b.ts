// PROTOTYPE — not production. Variant B: a two-pane navigator. Left: a tree of phases → agents
// → nested agents with status glyphs and live mini-stats (plus the blackboard and messages for a
// swarm). Right: whatever is focused, with Summary/Diff/Logs/Actions tabs. One-line input.
import { bold, type KeyEvent } from "@amira/tui-kit"
import {
  type App,
  boardLines,
  children,
  detailTab,
  inputText,
  keepVisible,
  msgLines,
  phaseLines,
  region,
  runOf,
  TABS,
  tabsRow,
  topBar,
  type Variant,
  viewport,
} from "./app.ts"
import { type Agent, phaseAgents } from "./sim.ts"
import { C, cost, dur, fit, glyph, hjoin, lr, phaseGlyph, rule, runtime, statusWord, tok, vw } from "./ui.ts"

interface Node {
  id: string
  depth: number
  line: (w: number) => string
}

function agentStat(app: App, a: Agent, narrow: boolean): string {
  const run = runOf(app)
  if (a.status === "queued") return C.muted("queued")
  if (a.status === "approval") return C.warn("approve?")
  const done = a.steps.filter((s) => s.state === "done").length
  const steps = a.steps.length ? `${done}/${a.steps.length}` : ""
  const add = a.files.reduce((s, f) => s + f.add, 0)
  const del = a.files.reduce((s, f) => s + f.del, 0)
  const files = a.files.length ? `${C.add(`+${add}`)}${C.del(`-${del}`)}` : ""
  const time = !narrow && (a.status === "running" || a.status === "paused") ? C.muted(runtime(run, a)) : ""
  return [steps && C.muted(steps), files, time].filter(Boolean).join(" ")
}

function tree(app: App): Node[] {
  const run = runOf(app)
  const nodes: Node[] = []
  const pushAgent = (a: Agent, depth: number, last: boolean, rail: string) => {
    nodes.push({
      id: a.id,
      depth,
      line: (w) => {
        const pre = `${rail}${C.border(last ? "└ " : "├ ")}`
        return lr(`${pre}${glyph(a.status, app.now)} ${a.name}`, agentStat(app, a, w < 34), w)
      },
    })
    const kids = children(run, a.id)
    if (kids.length && !app.collapsed.has(a.id))
      kids.forEach((k, i) =>
        pushAgent(k, depth + 1, i === kids.length - 1, rail + C.border(last ? "  " : "│ ")),
      )
  }
  for (const p of run.phases) {
    const as = phaseAgents(run, p.id)
    const open =
      as.length > 0 && (app.expanded.has(p.id) || p.status === "running") && !app.collapsed.has(p.id)
    const arrow = as.length ? (open ? "▾" : "▸") : " "
    nodes.push({
      id: p.id,
      depth: 0,
      line: (w) => {
        const running = as.filter((a) => a.status === "running" || a.status === "approval").length
        const stat =
          p.status === "running" && as.length
            ? C.run(`${running}/${as.length}`)
            : p.startedAt !== undefined && p.status !== "running" && p.id !== "ph:request"
              ? C.muted(dur((p.endedAt ?? run.clock) - p.startedAt))
              : ""
        const name =
          p.status === "running" ? C.run(bold(p.name)) : p.status === "waiting" ? C.muted(p.name) : p.name
        return lr(`${C.muted(arrow)} ${phaseGlyph(p, app.now)} ${name}`, stat, w)
      },
    })
    if (open) as.forEach((a, i) => pushAgent(a, 1, i === as.length - 1, "  "))
  }
  if (run.kind === "swarm") {
    nodes.push({ id: "sep", depth: 0, line: (w) => C.border("┄".repeat(w)) })
    nodes.push({
      id: "board",
      depth: 0,
      line: (w) => lr(`  ${C.accent("◆")} Blackboard`, C.muted(String(run.board.length)), w),
    })
    nodes.push({
      id: "msgs",
      depth: 0,
      line: (w) => lr(`  ${C.accent("◆")} Messages`, C.muted(String(run.msgs.length)), w),
    })
  }
  return nodes
}

function rightPane(app: App, w: number, h: number, x: number, y: number): string[] {
  const run = runOf(app)
  const id = app.sel[app.data]
  const a = run.agents.find((z) => z.id === id)
  const out: string[] = []
  const tail = TABS[app.tab] === "Logs"
  if (a) {
    out.push(
      lr(
        ` ${glyph(a.status, app.now)} ${bold(a.name)} ${C.muted("·")} ${a.task} ${C.tag(`[${a.tag}]`)}`,
        `${statusWord(a)} ${C.muted(`${runtime(run, a)} · ${tok(a.tokens)} tok · ${cost(a.cost)}`)} `,
        w,
      ),
    )
    out.push(tabsRow(app, w, C.muted("Tab ⇄  PgUp/PgDn ")))
    out.push(C.border("─".repeat(w)))
    const body = detailTab(app, a, w - 2)
    region(app, "b.right", x, y + 3, w, h - 3, tail)
    out.push(...viewport(app, "b.right", body, h - 3, tail).map((l) => ` ${l}`))
    return out
  }
  let title = ""
  let body: string[] = []
  if (id === "board") {
    title = `${C.accent("◆")} ${bold("Blackboard")} ${C.muted("shared facts, decisions and risks")}`
    body = boardLines(run, w - 2)
  } else if (id === "msgs") {
    title = `${C.accent("◆")} ${bold("Messages")} ${C.muted("between members, and yours")}`
    body = msgLines(run, w - 2)
  } else {
    const ph = run.phases.find((p) => p.id === id)
    if (ph) {
      title = `${phaseGlyph(ph, app.now)} ${bold(ph.name)}`
      body = phaseLines(app, ph, w - 2)
    }
  }
  out.push(` ${title}`, C.border("─".repeat(w)))
  const t = id === "msgs"
  region(app, "b.right", x, y + 2, w, h - 2, t)
  out.push(...viewport(app, "b.right", body, h - 2, t).map((l) => ` ${l}`))
  return out
}

function render(app: App, w: number, h: number): string[] {
  const out = [topBar(app, w), C.border("─".repeat(w))]
  const bodyH = h - 4
  const lw = Math.max(26, Math.min(44, Math.round(w * 0.32)))
  const rw = w - lw - 1
  const nodes = tree(app)
  const idx = nodes.findIndex((n) => n.id === app.sel[app.data])
  keepVisible(app, "b.tree", Math.max(0, idx), bodyH)
  region(app, "b.tree", 0, 2, lw, bodyH)
  const treeLines = viewport(
    app,
    "b.tree",
    nodes.map((n) => {
      const l = fit(` ${n.line(lw - 2)}`, lw)
      return n.id === app.sel[app.data] ? C.sel(l) : l
    }),
    bodyH,
  )
  const sep = Array.from({ length: bodyH }, () => C.border("│"))
  const right = rightPane(app, rw, bodyH, lw + 1, 2)
  out.push(
    ...hjoin([
      { lines: treeLines, w: lw },
      { lines: sep, w: 1 },
      { lines: right, w: rw },
    ]),
  )
  out.push(rule(w, app.inputOn ? C.run("typing · Enter send · Esc cancel") : ""))
  out.push(inputText(app, w))
  return out
}

function key(app: App, e: KeyEvent): boolean {
  const run = runOf(app)
  const nodes = tree(app).filter((n) => n.id !== "sep")
  const cur = app.sel[app.data]
  const i = Math.max(
    0,
    nodes.findIndex((n) => n.id === cur),
  )
  const move = (d: number) => {
    app.sel[app.data] = nodes[Math.max(0, Math.min(nodes.length - 1, i + d))]!.id
    app.scroll["b.right"] = 0
    return true
  }
  switch (e.name) {
    case "up":
    case "k":
      return move(-1)
    case "down":
    case "j":
      return move(1)
    case "home":
      return move(-999)
    case "end":
      return move(999)
    case "right":
    case "enter": {
      if (cur.startsWith("ph:")) {
        const open = app.expanded.has(cur) && !app.collapsed.has(cur)
        if (open && e.name === "enter") {
          app.collapsed.add(cur)
          app.expanded.delete(cur)
        } else {
          app.collapsed.delete(cur)
          app.expanded.add(cur)
        }
      } else if (children(run, cur).length) {
        if (app.collapsed.has(cur)) app.collapsed.delete(cur)
        else if (e.name === "enter") app.collapsed.add(cur)
      } else if (e.name === "right") app.tab = (app.tab + 1) % TABS.length
      return true
    }
    case "left": {
      const a = run.agents.find((x) => x.id === cur)
      if (a) app.sel[app.data] = a.parent ?? a.phase
      else if (cur.startsWith("ph:")) {
        app.collapsed.add(cur)
        app.expanded.delete(cur)
      }
      return true
    }
  }
  return false
}

export const variantB: Variant = { name: "Navigator", mainScroll: "b.right", mainTail: true, render, key }
void vw
