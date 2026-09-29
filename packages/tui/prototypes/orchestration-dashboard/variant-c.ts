// PROTOTYPE — not production. Variant C: lanes. A workflow is a board with a column per phase
// plus Done, and agent cards move right as they finish; a swarm gets a column per member with
// its latest messages, plus the blackboard. Enter opens a detail overlay; a slim event ticker
// sits above a one-line input.
import { bold, type KeyEvent } from "@amira/tui-kit"
import {
  type App,
  children,
  eventLine,
  inputText,
  keepVisible,
  region,
  runOf,
  topBar,
  type Variant,
  viewport,
} from "./app.ts"
import { type Agent, ended, type Run, topLevel } from "./sim.ts"
import { C, currentStep, fileStats, fit, frame, glyph, hjoin, lr, pips, rule, runtime, wrap } from "./ui.ts"

interface Lane {
  key: string
  title: string
  cards: Agent[]
  /** Extra lines under the cards (swarm messages, blackboard). */
  extra?: (w: number) => string[]
}

function lanes(app: App, w: number): Lane[] {
  const run = runOf(app)
  if (run.kind === "swarm") return swarmLanes(run, w)
  const out: Lane[] = []
  for (const p of run.phases) {
    if (p.id === "ph:request" || p.id === "ph:complete") continue
    const cards = topLevel(run).filter((a) => a.phase === p.id && a.status !== "done")
    out.push({ key: p.id, title: p.name, cards })
  }
  const done = topLevel(run)
    .filter((a) => a.status === "done")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  out.push({ key: "done", title: "Done", cards: done })
  return out
}

function swarmLanes(run: Run, w: number): Lane[] {
  const names = [...new Set(topLevel(run).map((a) => a.name))]
  const out: Lane[] = names.map((name) => {
    const mine = topLevel(run).filter((a) => a.name === name)
    const current =
      mine.find((a) => !ended(a) && a.status !== "queued") ?? [...mine].reverse().find(ended) ?? mine[0]!
    return {
      key: `m:${name}`,
      title: name,
      cards: [current],
      extra: (cw: number) => {
        const said = run.msgs.filter((m) => m.from === name || m.to === name)
        const lines: string[] = []
        for (const m of said) {
          const head =
            m.from === name
              ? C.accent(`→ @${m.to}`)
              : m.from === "you"
                ? C.user("from you")
                : C.muted(`from ${m.from}`)
          lines.push(head)
          for (const r of wrap(m.text, cw - 2))
            lines.push(`${C.border("│")} ${m.from === name ? r : C.muted(r)}`)
        }
        return lines
      },
    }
  })
  if (w >= 100)
    out.push({
      key: "board",
      title: "Blackboard",
      cards: [],
      extra: (cw: number) =>
        run.board.flatMap((b) => [
          C.accent(bold(b.key)),
          ...wrap(b.value, cw - 1).map((r) => ` ${r}`),
          C.muted(` — ${b.by}`),
        ]),
    })
  return out
}

function card(app: App, a: Agent, w: number, selected: boolean): string[] {
  const run = runOf(app)
  const color = selected
    ? C.focusBorder
    : a.status === "approval"
      ? C.warn
      : a.status === "failed"
        ? C.err
        : C.border
  const title = `${glyph(a.status, app.now)} ${bold(a.name)}`
  const right = a.status === "queued" ? "" : C.muted(runtime(run, a))
  const inner = w - 2
  let body: string[]
  if (a.status === "queued") body = [C.muted(fit(a.task, inner)), C.muted("queued")]
  else if (a.status === "done" && run.kind === "workflow") body = [fit(a.task, inner), fileStats(a)]
  else {
    body = [fit(a.task, inner), pips(a.steps) || C.muted(a.role)]
    if (a.status === "approval")
      body.push(...wrap(C.warn(`? ${a.approval}`), inner).slice(0, 2), C.warn("a approve · x deny"))
    else {
      const now = currentStep(a)
      if (now) body.push(`${C.run("›")} ${now}`)
      if (a.tool) body.push(C.muted(`● ${a.tool}`))
      else if (a.partial)
        body.push(C.think(a.partial.text.slice(0, Math.floor(a.partial.shown)).slice(-inner + 1)))
    }
    if (a.status === "paused") body.push(C.warn("‖ paused (p resumes)"))
    body.push(fileStats(a))
  }
  const kids = children(run, a.id)
  kids.forEach((k, i) =>
    body.push(`${C.border(i === kids.length - 1 ? "└" : "├")} ${glyph(k.status, app.now)} ${k.name}`),
  )
  return frame(
    body.map((l) => fit(l, inner)),
    w,
    body.length + 2,
    {
      title,
      right,
      color,
      heavy: selected,
      bottom: a.status === "approval" ? C.warn("needs you") : undefined,
    },
  )
}

function laneLines(
  app: App,
  lane: Lane,
  w: number,
  h: number,
  index: number,
  x: number,
  y: number,
): string[] {
  const sel = app.sel[app.data]
  const lines: string[] = []
  let selAt = -1
  let selH = 0
  for (const a of lane.cards) {
    const c = card(app, a, w, a.id === sel)
    if (a.id === sel) {
      selAt = lines.length
      selH = c.length
    }
    lines.push(...c)
  }
  const extra = lane.extra?.(w) ?? []
  const name = `c.lane.${index}`
  const hdr = `${lane.key === "board" ? C.accent("◆ ") : ""}${bold(lane.title.toUpperCase())} ${C.muted(
    lane.key.startsWith("m:")
      ? (lane.cards[0]?.role ?? "")
      : lane.key === "board"
        ? String(runOf(app).board.length)
        : String(lane.cards.length),
  )}`
  const bodyH = h - 2
  if (lane.extra) {
    // Member columns: the card on top, the message stream below it keeps to its newest line.
    const top = lines.slice(0, Math.min(lines.length, Math.floor(bodyH * 0.6)))
    const restH = bodyH - top.length
    region(app, name, x, y + 2 + top.length, w, restH, true)
    return [fit(hdr, w), C.border("─".repeat(w)), ...top, ...viewport(app, name, extra, restH, true)]
  }
  if (!lines.length) lines.push(C.muted(fit("  (empty)", w)))
  if (selAt >= 0) {
    keepVisible(app, name, selAt + selH - 1, bodyH)
    keepVisible(app, name, selAt, bodyH)
  }
  region(app, name, x, y + 2, w, bodyH)
  const shown = viewport(app, name, lines, bodyH)
  const hidden = lines.length - bodyH - (app.scroll[name] ?? 0)
  if (hidden > 0) shown[bodyH - 1] = C.muted(fit(`  ↓ ${lane.cards.length} cards, more below`, w))
  return [fit(hdr, w), C.border("─".repeat(w)), ...shown]
}

function render(app: App, w: number, h: number): string[] {
  const run = runOf(app)
  const out = [topBar(app, w), C.border("─".repeat(w))]
  const tickN = h >= 30 ? 3 : 2
  const lanesH = h - 2 - (tickN + 1) - 1
  const ls = lanes(app, w)
  const gap = 1
  const lw = Math.floor((w - gap * (ls.length - 1)) / ls.length)
  const cols = ls.map((lane, i) => ({
    lines: laneLines(app, lane, lw, lanesH, i, i * (lw + gap), 2),
    w: lw,
  }))
  out.push(...hjoin(cols, " ").map((l) => fit(l, w)))
  // Ticker
  const pending = run.agents.filter((a) => a.status === "approval")
  out.push(
    rule(
      w,
      pending.length
        ? C.warn(bold(`? ${pending.map((a) => a.name).join(", ")} waiting for approval · a approve · x deny`))
        : C.muted("events"),
    ),
  )
  const evs = run.events.slice(-tickN)
  for (let i = 0; i < tickN; i++) out.push(evs[i] ? ` ${eventLine(run, evs[i]!, w - 1)}` : "")
  out.push(inputText(app, w))
  return out
}

function grid(app: App): string[][] {
  return lanes(app, 200).map((l) => (l.key === "board" ? ["board"] : l.cards.map((c) => c.id)))
}

function key(app: App, e: KeyEvent): boolean {
  const g = grid(app)
  const cur = app.sel[app.data]
  let col = g.findIndex((ids) => ids.includes(cur))
  let row = col >= 0 ? g[col]!.indexOf(cur) : 0
  if (col < 0) {
    col = Math.max(
      0,
      g.findIndex((ids) => ids.length > 0),
    )
    row = 0
  }
  const set = (c: number, r: number) => {
    const ids = g[c]
    if (!ids?.length) return false
    app.sel[app.data] = ids[Math.max(0, Math.min(ids.length - 1, r))]!
    return true
  }
  switch (e.name) {
    case "left":
    case "h":
      for (let c = col - 1; c >= 0; c--) if (set(c, row)) break
      return true
    case "right":
    case "l":
      for (let c = col + 1; c < g.length; c++) if (set(c, row)) break
      return true
    case "up":
    case "k":
      set(col, row - 1)
      return true
    case "down":
    case "j":
      set(col, row + 1)
      return true
    case "enter": {
      const id = app.sel[app.data]
      if (runOf(app).agents.some((a) => a.id === id)) {
        app.overlay = { kind: "detail", id }
        app.scroll.detail = 0
      }
      return true
    }
  }
  return false
}

export const variantC: Variant = { name: "Lanes", mainScroll: "detail", mainTail: true, render, key }
void lr
