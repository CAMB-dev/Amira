// PROTOTYPE — not production. App state, shared panels, overlays and key handling for the
// orchestration dashboard prototype. The three layouts live in variant-a/b/c.ts.
import {
  bold,
  type Component,
  defaultTheme,
  type InputEvent,
  type KeyEvent,
  LineInput,
  type RenderContext,
} from "@amira/tui-kit"
import {
  type Agent,
  byId,
  children,
  decide,
  message,
  type Phase,
  phaseAgents,
  type Run,
  requestChanges,
  swarmRun,
  tick,
  togglePause,
  workflowRun,
} from "./sim.ts"
import {
  C,
  clock,
  cost,
  currentPhase,
  currentStep,
  diffLines,
  dur,
  fileRows,
  fileStats,
  fit,
  frame,
  glyph,
  hjoin,
  logLines,
  lr,
  overlay,
  phaseGlyph,
  pips,
  runtime,
  statusWord,
  stepLines,
  tok,
  totals,
  vw,
  wrap,
} from "./ui.ts"

export type DataKey = "workflow" | "swarm"
export const TABS = ["Summary", "Diff", "Logs", "Actions"] as const

export interface Region {
  x: number
  y: number
  w: number
  h: number
  name: string
  tail: boolean
}

export interface Variant {
  name: string
  /** The scroll area PgUp/PgDn move. */
  mainScroll: string
  mainTail: boolean
  render(app: App, w: number, h: number): string[]
  key(app: App, e: KeyEvent): boolean
}

export interface App {
  runs: Record<DataKey, Run>
  data: DataKey
  variant: number
  variants: Variant[]
  tab: number
  speed: number
  paused: boolean
  sel: Record<DataKey, string>
  expanded: Set<string>
  collapsed: Set<string>
  autoOpened: Set<string>
  scroll: Record<string, number>
  overlay?: { kind: "diff" | "detail"; id: string }
  input: LineInput
  inputOn: boolean
  inputMode: "msg" | "request"
  inputTarget?: string
  flash?: { text: string; at: number }
  regions: Region[]
  /** Wall-clock seconds, for blinking. */
  now: number
  onQuit: () => void
}

export const SPEEDS = [0.5, 1, 2, 4, 8]

export function createApp(variants: Variant[], onQuit: () => void = () => {}): App {
  return {
    runs: { workflow: workflowRun(), swarm: swarmRun() },
    data: "workflow",
    variant: 0,
    variants,
    tab: 0,
    speed: 1,
    paused: false,
    sel: { workflow: "planner", swarm: "lead" },
    expanded: new Set(),
    collapsed: new Set(),
    autoOpened: new Set(),
    scroll: {},
    input: new LineInput(),
    inputOn: false,
    inputMode: "msg",
    regions: [],
    now: 0,
    onQuit,
  }
}

export const runOf = (app: App) => app.runs[app.data]

/** Advances both data sets, so switching shows the other one still moving. */
export function step(app: App, dt: number) {
  app.now += dt
  if (app.paused) return
  for (const r of Object.values(app.runs)) {
    tick(r, dt * app.speed)
  }
  // Running phases open by themselves and close again when they finish, unless the user
  // opened or closed them.
  for (const r of Object.values(app.runs))
    for (const p of r.phases) {
      if (p.status === "running" && !app.collapsed.has(p.id) && !app.expanded.has(p.id)) {
        app.expanded.add(p.id)
        app.autoOpened.add(p.id)
      } else if (p.status !== "running" && app.autoOpened.has(p.id)) {
        app.expanded.delete(p.id)
        app.autoOpened.delete(p.id)
      }
    }
}

export function selectedAgent(app: App): Agent | undefined {
  const run = runOf(app)
  const id = app.sel[app.data]
  const a = byId(run, id)
  if (a) return a
  const ph = run.phases.find((p) => p.id === id)
  if (!ph) return undefined
  const as = phaseAgents(run, ph.id)
  return as.find((x) => x.status === "running" || x.status === "approval") ?? as[0]
}

export function flash(app: App, text: string) {
  app.flash = { text, at: app.now }
}

// ---------------------------------------------------------------------------------------------
// Scroll areas

export function viewport(app: App, name: string, lines: string[], h: number, tail = false): string[] {
  const max = Math.max(0, lines.length - h)
  const off = Math.max(0, Math.min(max, app.scroll[name] ?? 0))
  app.scroll[name] = off
  const top = tail ? max - off : off
  const out = lines.slice(top, top + h)
  while (out.length < h) out.push("")
  return out
}

export function region(app: App, name: string, x: number, y: number, w: number, h: number, tail = false) {
  app.regions.push({ name, x, y, w, h, tail })
}

export function scrollBy(app: App, name: string, tail: boolean, rows: number) {
  app.scroll[name] = Math.max(0, (app.scroll[name] ?? 0) + (tail ? -rows : rows))
}

/** Scrolls `name` so that line `index` is inside an `h`-row window (top-anchored areas). */
export function keepVisible(app: App, name: string, index: number, h: number) {
  const top = app.scroll[name] ?? 0
  if (index < top) app.scroll[name] = index
  else if (index >= top + h) app.scroll[name] = index - h + 1
}

// ---------------------------------------------------------------------------------------------
// Shared pieces

export function topBar(app: App, w: number): string {
  const run = runOf(app)
  const t = totals(run)
  const sep = C.muted(" │ ")
  const segs: { s: string; prio: number }[] = [
    { s: C.accent(bold("amira")), prio: 9 },
    { s: `${C.muted("workspace:")} ${run.workspace}`, prio: 2 },
    { s: `${C.muted(run.kind + ":")} ${run.title}`, prio: 4 },
    { s: `${C.muted("phase:")} ${C.run(currentPhase(run).name.toLowerCase())}`, prio: 8 },
    { s: `${C.muted("running")} ${C.run(`${t.running}/${t.total}`)}`, prio: 8 },
    ...(t.approvals ? [{ s: C.warn(bold(`? ${t.approvals} needs approval (a/x)`)), prio: 9 }] : []),
    { s: `${C.muted("tokens")} ${tok(t.tokens)}`, prio: 3 },
    { s: `${C.muted("cost")} ${cost(t.cost)}`, prio: 7 },
    { s: `${C.muted("elapsed")} ${dur(run.clock)}`, prio: 5 },
  ]
  let shown = segs
  const width = (xs: typeof segs) => vw(xs.map((x) => x.s).join(" │ ")) + 1
  for (let p = 1; p < 9 && width(shown) > w; p++) shown = shown.filter((x) => x.prio > p)
  return fit(` ${shown.map((x) => x.s).join(sep)}`, w)
}

export function tabsRow(app: App, w: number, right = ""): string {
  const s = ` ${TABS.map((t, i) => (i === app.tab ? C.run(bold(`[${t}]`)) : C.muted(` ${t} `))).join(" ")}`
  return lr(s, right, w)
}

/** The body of a detail tab for one agent, unclipped; callers put it in a viewport. */
export function detailTab(app: App, a: Agent, w: number): string[] {
  const run = runOf(app)
  switch (TABS[app.tab]) {
    case "Diff":
      return diffLines(a.files, w)
    case "Logs":
      return logLines(run, a, w)
    case "Actions":
      return actionLines(app, a, w)
    default:
      return summaryLines(app, a, w)
  }
}

function metaLines(run: Run, a: Agent): string[] {
  const kv = (k: string, v: string) => `${C.muted(k.padEnd(9))}${v}`
  return [
    kv("Agent", `${a.role} (${a.name})`),
    kv("Task", a.task),
    kv("Kind", a.tag),
    kv("Status", statusWord(a)),
    kv("Runtime", runtime(run, a)),
    kv("Started", a.startedAt === undefined ? "—" : clock(a.startedAt)),
    kv("Tokens", `${tok(a.tokens)} · ${cost(a.cost)}`),
  ]
}

function doingLines(app: App, a: Agent, w: number): string[] {
  const run = runOf(app)
  const out = [bold("What this agent is doing"), ...wrap(C.muted(a.summary), w)]
  if (a.approval)
    out.push("", C.warn(bold("Waiting for you: ")) + C.warn(a.approval), C.muted("a approve · x deny"))
  else if (a.tool) out.push(`${C.muted("now")} ${C.run("●")} ${a.tool}`)
  if (a.steps.length) out.push("", `${bold("Steps")}  ${pips(a.steps)}`, ...stepLines(a.steps, w))
  const kids = children(run, a.id)
  if (kids.length) {
    out.push("", bold("Sub-agents"))
    kids.forEach((k, i) =>
      out.push(
        fit(`${i === kids.length - 1 ? "└" : "├"} ${glyph(k.status)} ${k.name}  ${C.muted(k.task)}`, w),
      ),
    )
  }
  return out
}

function filesAndNotes(app: App, a: Agent, w: number): string[] {
  const run = runOf(app)
  const out = [lr(bold("Changed files"), C.muted(`${a.files.length} file${a.files.length === 1 ? "" : "s"}`), w), ...fileRows(a.files, w)]
  if (!a.files.length) out.push(C.muted("none yet"))
  if (a.notes.length) out.push("", bold("Notes"), ...a.notes.flatMap((n) => wrap(C.muted(n), w)))
  const said = run.msgs.filter((m) => m.from === a.name).slice(-3)
  if (said.length) {
    out.push("", bold("Latest messages"))
    for (const m of said) out.push(...wrap(`${C.accent(`→@${m.to}`)} ${m.text}`, w))
  }
  return out
}

export function summaryLines(app: App, a: Agent, w: number): string[] {
  const run = runOf(app)
  if (w >= 100) {
    const mw = 30
    const fw = Math.min(46, Math.floor((w - mw) / 2.2))
    const dw = w - mw - fw - 6
    return hjoin(
      [
        { lines: metaLines(run, a), w: mw },
        { lines: doingLines(app, a, dw), w: dw },
        { lines: filesAndNotes(app, a, fw), w: fw },
      ],
      C.border(" │ "),
    )
  }
  if (w >= 70) {
    const mw = 32
    const dw = w - mw - 3
    return [
      ...hjoin(
        [
          { lines: metaLines(run, a), w: mw },
          { lines: doingLines(app, a, dw), w: dw },
        ],
        C.border(" │ "),
      ),
      "",
      ...filesAndNotes(app, a, w),
    ]
  }
  return [...metaLines(run, a), "", ...doingLines(app, a, w), "", ...filesAndNotes(app, a, w)]
}

export function actionLines(app: App, a: Agent, w: number): string[] {
  const row = (k: string, label: string, enabled = true) =>
    fit(`${enabled ? C.run(bold(k.padEnd(4))) : C.muted(k.padEnd(4))}${enabled ? label : C.muted(label)}`, w)
  const out = [
    bold(`Actions for ${a.name}`),
    "",
    row("o", `Open diff (${a.files.length} files)`, a.files.length > 0),
    row(
      "p",
      a.status === "paused" ? "Resume" : "Pause",
      a.status !== "done" && a.status !== "failed" && a.status !== "queued",
    ),
    row("r", "Request changes (types into the input box)"),
    row("a", a.approval ? `Approve: ${a.approval}` : "Approve (nothing pending)", !!a.approval),
    row("x", a.approval ? "Deny and skip that command" : "Deny (nothing pending)", !!a.approval),
    row("@", `Message ${a.name} directly`),
  ]
  return out
}

export function phaseLines(app: App, ph: Phase, w: number): string[] {
  const run = runOf(app)
  const as = phaseAgents(run, ph.id)
  const out = [
    `${phaseGlyph(ph)} ${bold(ph.name)}  ${C.muted(ph.ref)}  ${C.muted(ph.status)}${
      ph.startedAt !== undefined ? C.muted(` · ${dur((ph.endedAt ?? run.clock) - ph.startedAt)}`) : ""
    }`,
    "",
  ]
  if (ph.id === "ph:request") out.push(...wrap(run.request, w))
  for (const a of as)
    out.push(fit(`${glyph(a.status)} ${a.name.padEnd(11)} ${pips(a.steps)}  ${fileStats(a)}`, w))
  if (!as.length && ph.id !== "ph:request") out.push(C.muted("No agents in this phase."))
  return out
}

export function boardLines(run: Run, w: number): string[] {
  if (!run.board.length) return [C.muted("The blackboard is empty.")]
  const out: string[] = []
  for (const b of run.board) {
    const head = `${C.muted(clock(b.at))} ${C.accent(b.key.padEnd(10))} `
    const rows = wrap(b.value, w - 20)
    rows.forEach((r, i) => out.push(fit(i ? `${" ".repeat(20)}${r}` : `${head}${r}`, w - 0)))
    out.push(fit(`${" ".repeat(20)}${C.muted(`— ${b.by}`)}`, w))
  }
  return out
}

export function msgLines(run: Run, w: number, filter?: (m: Run["msgs"][number]) => boolean): string[] {
  const ms = run.msgs.filter(filter ?? (() => true))
  if (!ms.length) return [C.muted("No messages yet.")]
  const out: string[] = []
  for (const m of ms) {
    const from = m.from === "you" ? C.user(m.from) : C.accent(m.from)
    out.push(fit(`${C.muted(clock(m.at))} ${from} ${C.muted(`→ @${m.to}`)}`, w))
    for (const r of wrap(m.text, w - 9)) out.push(`         ${r}`)
  }
  return out
}

export function eventLine(run: Run, e: Run["events"][number], w: number): string {
  const tone =
    e.tone === "ok"
      ? C.ok
      : e.tone === "err"
        ? C.err
        : e.tone === "warn"
          ? C.warn
          : e.tone === "user"
            ? C.user
            : (s: string) => s
  return fit(`${C.muted(clock(e.at))}  ${C.accent(e.who.padEnd(10))} ${tone(e.text)}`, w)
}

/** The input box's inner line: the prompt and the text, or a placeholder. */
export function inputText(app: App, w: number): string {
  const run = runOf(app)
  const prompt =
    app.inputMode === "request" ? C.warn(`request changes → ${app.inputTarget} › `) : C.run(bold("› "))
  const pw = vw(prompt)
  if (!app.inputOn && !app.input.value) {
    const hint =
      run.kind === "swarm"
        ? "i to message the lead · @name to message a member · r request changes"
        : "i to ask the commander · @name to message a worker · r request changes"
    return prompt + C.muted(fit(hint, w - pw))
  }
  return prompt + app.input.render(w - pw, defaultTheme, { focused: app.inputOn })
}

export function footer(app: App, w: number): string {
  const v = app.variants[app.variant]!
  const letter = "ABC"[app.variant]
  const data =
    app.data === "workflow"
      ? `${C.barKey("workflow")}${C.bar("|swarm")}`
      : `${C.bar("workflow|")}${C.barKey("swarm")}`
  const left =
    C.barKey(` Variant ${letter} — ${v.name} `) +
    C.bar("· ") +
    C.barKey("[ ]") +
    C.bar(" switch · ") +
    C.barKey("d") +
    C.bar(" data: ") +
    data +
    C.bar(" · ") +
    C.barKey("q") +
    C.bar(" quit ")
  const flashOn = app.flash && app.now - app.flash.at < 4
  const speed = `${app.paused ? "‖ paused" : "▶"} ${app.speed}x  space +/- `
  const room = w - vw(left)
  const options = flashOn
    ? [` ${app.flash!.text} `]
    : [` ${speed}`, ` ${app.paused ? "‖" : "▶"} ${app.speed}x `, ""]
  const right = options.find((o) => vw(o) <= room) ?? ""
  if (room <= 0) return fit(left, w)
  return left + C.bar(" ".repeat(room - vw(right)) + right)
}

// ---------------------------------------------------------------------------------------------
// Overlays

function diffOverlay(app: App, w: number, h: number): string[] {
  const run = runOf(app)
  const a = byId(run, app.overlay!.id)
  if (!a) return []
  const lines = diffLines(a.files, w - 4).map((l) => ` ${l}`)
  region(app, "diff", 1, 1, w - 2, h - 2)
  const body = viewport(app, "diff", lines, h - 2)
  const pos = `${Math.min(lines.length, (app.scroll.diff ?? 0) + h - 2)}/${lines.length}`
  return frame(body, w, h, {
    title: `${bold("Diff")} · ${a.name} · ${a.task} · ${fileStats(a)}`,
    right: C.muted(`↑↓ PgUp/PgDn scroll · Esc back · ${pos}`),
    color: C.focusBorder,
  })
}

function detailOverlay(app: App, base: string[], w: number, h: number): string[] {
  const run = runOf(app)
  const a = byId(run, app.overlay!.id)
  if (!a) return base
  const bw = Math.min(w - 2, Math.max(60, Math.floor(w * 0.88)))
  const bh = Math.max(10, Math.floor(h * 0.84))
  const inner = bw - 4
  const tabs = tabsRow(app, inner, C.muted("Tab next · o diff · Esc close"))
  const lines = detailTab(app, a, inner)
  const vh = bh - 4
  const x = Math.floor((w - bw) / 2)
  const y = Math.floor((h - bh) / 2)
  const tail = TABS[app.tab] === "Logs"
  region(app, "detail", x + 2, y + 3, inner, vh, tail)
  const body = [tabs, C.border("─".repeat(inner)), ...viewport(app, "detail", lines, vh, tail)].map(
    (l) => ` ${fit(l, inner)} `,
  )
  const box = frame(body, bw, bh, {
    title: `${glyph(a.status)} ${bold(a.name)} · ${a.task} · ${statusWord(a)}`,
    right: C.muted(`${runtime(run, a)} · ${tok(a.tokens)} tok`),
    color: C.focusBorder,
    heavy: true,
  })
  return overlay(base, box, x, y)
}

// ---------------------------------------------------------------------------------------------
// Frame

export function renderApp(app: App, w: number, h: number): string[] {
  app.regions = []
  const v = app.variants[app.variant]!
  const bodyH = h - 1
  let body: string[]
  if (app.overlay?.kind === "diff") body = diffOverlay(app, w, bodyH)
  else {
    body = v.render(app, w, bodyH)
    if (app.overlay?.kind === "detail") {
      app.regions = []
      body = detailOverlay(app, body, w, bodyH)
    }
  }
  const out = body.slice(0, bodyH).map((l) => fit(l, w))
  while (out.length < bodyH) out.push("")
  out.push(footer(app, w))
  return out
}

export function rootComponent(app: App): Component {
  return {
    render: (width: number, ctx: RenderContext) => renderApp(app, width, ctx.rows),
  }
}

// ---------------------------------------------------------------------------------------------
// Input

function startInput(app: App, mode: "msg" | "request", prefill = "") {
  const a = selectedAgent(app)
  if (mode === "request" && !a) return flash(app, "Select an agent first")
  app.inputOn = true
  app.inputMode = mode
  app.inputTarget = a?.id
  if (mode === "request") app.inputTarget = a!.name
  app.input.value = prefill
}

function submitInput(app: App) {
  const run = runOf(app)
  const text = app.input.value.trim()
  app.input.value = ""
  app.inputOn = false
  if (!text) return
  if (app.inputMode === "request") {
    const a = run.agents.find((x) => x.name === app.inputTarget)
    if (a) flash(app, requestChanges(run, a, text))
  } else flash(app, message(run, text))
  app.inputMode = "msg"
}

function pendingApproval(app: App): Agent | undefined {
  const run = runOf(app)
  const a = selectedAgent(app)
  if (a?.approval) return a
  return run.agents.find((x) => x.status === "approval" || (x.status === "paused" && x.approval))
}

export function handleInput(app: App, e: InputEvent): void {
  if (e.type === "mouse") {
    if (e.action !== "wheel") return
    const r = app.regions.findLast((r) => e.x >= r.x && e.x < r.x + r.w && e.y >= r.y && e.y < r.y + r.h)
    if (!r) return
    const d = e.button === "up" ? -3 : e.button === "down" ? 3 : 0
    scrollBy(app, r.name, r.tail, d)
    return
  }
  if (e.type === "paste") {
    if (app.inputOn) app.input.insert(e.text)
    return
  }
  if (e.type !== "key") return
  if (e.ctrl && (e.name === "c" || e.name === "d")) return app.onQuit()
  if (e.name === "f1" || e.name === "f2" || e.name === "f3") {
    app.variant = Number(e.name[1]) - 1
    app.overlay = undefined
    return
  }
  if (app.inputOn) {
    if (e.name === "escape") {
      app.inputOn = false
      app.input.value = ""
      app.inputMode = "msg"
      return
    }
    if (e.name === "enter" && !e.shift && !e.alt) return submitInput(app)
    app.input.handleInput(e)
    return
  }
  const run = runOf(app)
  const v = app.variants[app.variant]!
  const n = app.variants.length
  if (app.overlay) {
    const name = app.overlay.kind === "diff" ? "diff" : "detail"
    const tail = app.overlay.kind === "detail" && TABS[app.tab] === "Logs"
    if (e.name === "escape" || (e.name === "enter" && app.overlay.kind === "detail")) {
      app.overlay = undefined
      return
    }
    if (e.name === "up") return scrollBy(app, name, tail, -1)
    if (e.name === "down") return scrollBy(app, name, tail, 1)
    if (e.name === "pageup") return scrollBy(app, name, tail, -10)
    if (e.name === "pagedown") return scrollBy(app, name, tail, 10)
  }
  switch (e.name) {
    case "q":
      return app.onQuit()
    case "[":
      app.variant = (app.variant + n - 1) % n
      app.overlay = undefined
      return
    case "]":
      app.variant = (app.variant + 1) % n
      app.overlay = undefined
      return
    case "d":
      app.data = app.data === "workflow" ? "swarm" : "workflow"
      app.overlay = undefined
      return
    case "space":
      app.paused = !app.paused
      return
    case "+":
    case "=":
      app.speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(app.speed) + 1)]!
      return
    case "-":
    case "_":
      app.speed = SPEEDS[Math.max(0, SPEEDS.indexOf(app.speed) - 1)]!
      return
    case "tab":
      app.tab = (app.tab + (e.shift ? TABS.length - 1 : 1)) % TABS.length
      app.scroll[v.mainScroll] = 0
      app.scroll.detail = 0
      return
    case "i":
    case "/":
      return startInput(app, "msg")
    case "@":
      return startInput(app, "msg", "@")
    case "r": {
      startInput(app, "request")
      return
    }
    case "p": {
      const a = selectedAgent(app)
      if (a) flash(app, togglePause(run, a))
      return
    }
    case "o": {
      const a = selectedAgent(app)
      if (!a) return
      app.overlay = { kind: "diff", id: a.id }
      app.scroll.diff = 0
      return
    }
    case "a":
    case "x": {
      const a = pendingApproval(app)
      if (!a) return flash(app, "Nothing is waiting for approval")
      if (a.status === "paused") a.status = "approval"
      flash(app, decide(run, a, e.name === "a"))
      return
    }
    case "pageup":
      return scrollBy(app, v.mainScroll, v.mainTail && TABS[app.tab] === "Logs", -8)
    case "pagedown":
      return scrollBy(app, v.mainScroll, v.mainTail && TABS[app.tab] === "Logs", 8)
  }
  if (e.text === "@") return startInput(app, "msg", "@")
  v.key(app, e)
}

export { byId, children, currentStep, phaseAgents }
