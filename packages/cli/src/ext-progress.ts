import type { InstallProgress } from "@amira/core"
import { cyan, dim, green, red, truncateToWidth, visibleWidth, yellow } from "@amira/tui-kit"

/**
 * How `amira ext install|update|remove` shows its work:
 * - tty: one line per package, redrawn in place with a spinner and the current phase;
 * - plain: one line per event (stdout is not a terminal, or NO_COLOR is set);
 * - quiet: only the results;
 * - json: one JSON object per line on stdout.
 */
export type ProgressMode = "tty" | "plain" | "quiet" | "json"

export type OutcomeKind = "installed" | "updated" | "up to date" | "removed" | "failed" | "cancelled"

export interface Outcome {
  kind: OutcomeKind
  /** Shown on the package's line in a terminal, e.g. "0.1.0 → 0.1.3". */
  text: string
  /** The line printed for it otherwise (stdout, or stderr for failures). */
  line: string
  /** Extra fields for --json. */
  data?: Record<string, unknown>
}

export interface ProgressOptions {
  mode: ProgressMode
  stdout: (s: string) => void
  stderr: (s: string) => void
  columns?: () => number | undefined
  rows?: () => number | undefined
  /** Spinner frame interval; 0 draws only on events (tests). */
  intervalMs?: number
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const PHASE_TEXT: Record<InstallProgress["phase"], string> = {
  resolving: "resolving",
  waiting: "waiting",
  fetching: "fetching",
  extracting: "extracting",
  copying: "copying",
  verifying: "verifying",
  dependencies: "installing dependencies",
}

interface Row {
  name: string
  /** How the package is shown: its name, or a short form of the spec it is installed from. */
  label: string
  phase?: InstallProgress["phase"]
  detail?: string
  percent?: number
  outcome?: Outcome
}

export class ExtProgress {
  private readonly rows: Row[] = []
  /** Rows before this index are finished and printed for good (terminal mode). */
  private committed = 0
  /** Lines drawn below the committed rows, redrawn on each update. */
  private drawn = 0
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(private readonly opts: ProgressOptions) {}

  get mode(): ProgressMode {
    return this.opts.mode
  }

  /** A package that will be worked on, shown as waiting until its first event. */
  add(name: string, label = name): void {
    this.row(name).label = label
    this.draw()
  }

  update(p: InstallProgress): void {
    const row = this.row(p.name)
    if (row.outcome) return
    const changed = row.phase !== p.phase || row.detail !== p.detail
    row.phase = p.phase
    row.detail = p.detail
    row.percent = p.percent
    switch (this.opts.mode) {
      case "tty":
        this.startTimer()
        this.draw()
        break
      case "plain":
        // Percentages would be a line each: only the phases.
        if (changed)
          this.opts.stderr(`amira: ${row.label}: ${PHASE_TEXT[p.phase]}${p.detail ? ` ${p.detail}` : ""}\n`)
        break
      case "json":
        this.json({ type: "progress", ...p })
        break
    }
  }

  finish(name: string, outcome: Outcome): void {
    const row = this.row(name)
    row.outcome = outcome
    switch (this.opts.mode) {
      case "tty":
        this.draw()
        break
      case "plain":
      case "quiet":
        if (outcome.kind === "failed" || outcome.kind === "cancelled") this.opts.stderr(`${outcome.line}\n`)
        else this.opts.stdout(`${outcome.line}\n`)
        break
      case "json":
        this.json({ type: "result", name, status: outcome.kind, ...outcome.data })
        break
    }
  }

  /** The package being worked on, if any: the one a Ctrl+C cancels. */
  active(): string | undefined {
    return this.rows.find((r) => !r.outcome && r.phase)?.name
  }

  /** A warning or hint, printed above the package lines. */
  note(line: string): void {
    if (this.opts.mode === "json") {
      this.json({ type: "warning", message: line.replace(/^amira: (warning: )?/, "") })
      return
    }
    if (this.opts.mode !== "tty") {
      this.opts.stderr(`${line}\n`)
      return
    }
    this.clear()
    this.opts.stderr(`${line}\n`)
    this.draw()
  }

  /** Stops the animation and prints the summary; returns it. */
  close(): string {
    if (this.closed) return ""
    this.closed = true
    clearInterval(this.timer)
    this.timer = undefined
    // Packages never reached (after a Ctrl+C) are dropped from the display.
    const done = this.rows.filter((r) => r.outcome)
    if (this.opts.mode === "tty") {
      this.clear()
      this.rows.splice(0, this.rows.length, ...done)
      this.committed = Math.min(this.committed, this.rows.length)
      this.draw(true)
    }
    const counts = new Map<OutcomeKind, number>()
    for (const r of done) counts.set(r.outcome!.kind, (counts.get(r.outcome!.kind) ?? 0) + 1)
    const order: OutcomeKind[] = ["installed", "updated", "up to date", "removed", "failed", "cancelled"]
    const summary = order
      .filter((k) => counts.get(k))
      .map((k) => `${counts.get(k)} ${k}`)
      .join(" · ")
    if (!summary) return ""
    if (this.opts.mode === "json") {
      this.json({
        type: "summary",
        ...Object.fromEntries(order.map((k) => [k.replace(/ /g, "_"), counts.get(k) ?? 0])),
      })
    } else if (this.opts.mode !== "quiet") this.opts.stdout(`${summary}\n`)
    return summary
  }

  private row(name: string): Row {
    let r = this.rows.find((x) => x.name === name && !x.outcome) ?? this.rows.find((x) => x.name === name)
    if (!r) {
      r = { name, label: name }
      this.rows.push(r)
    }
    return r
  }

  private json(v: unknown) {
    this.opts.stdout(`${JSON.stringify(v)}\n`)
  }

  private startTimer() {
    const ms = this.opts.intervalMs ?? 80
    if (this.timer || ms <= 0 || this.closed) return
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.draw()
    }, ms)
    this.timer.unref?.()
  }

  /** Moves back to the first redrawn line and erases everything below it. */
  private clear() {
    if (this.drawn > 0) this.opts.stdout(`\x1b[${this.drawn}F\x1b[J`)
    this.drawn = 0
  }

  private draw(final = false) {
    if (this.opts.mode !== "tty") return
    const width = Math.max(20, (this.opts.columns?.() ?? 80) - 1)
    const height = Math.max(3, (this.opts.rows?.() ?? 24) - 2)
    const nameWidth = Math.min(28, Math.max(...this.rows.map((r) => visibleWidth(r.label)), 4))
    let out = this.drawn > 0 ? `\x1b[${this.drawn}F` : ""
    // Finished lines at the top are printed once and scroll away with the terminal.
    while (this.committed < this.rows.length && this.rows[this.committed]!.outcome) {
      out += `\x1b[2K${this.line(this.rows[this.committed]!, nameWidth, width)}\n`
      this.committed++
    }
    const live = this.rows.slice(this.committed)
    // Never more lines than fit: cursor movements cannot reach above the screen.
    const shown = live.length > height ? live.slice(0, height - 1) : live
    const lines = shown.map((r) => this.line(r, nameWidth, width))
    if (shown.length < live.length) lines.push(dim(`… ${live.length - shown.length} more waiting`))
    for (const l of lines) out += `\x1b[2K${l}\n`
    out += "\x1b[J"
    this.drawn = final ? 0 : lines.length
    this.opts.stdout(out)
  }

  private line(r: Row, nameWidth: number, width: number): string {
    const name = padTo(truncateToWidth(r.label, nameWidth, "…"), nameWidth)
    let text: string
    if (r.outcome) {
      const o = r.outcome
      const mark = o.kind === "failed" ? red("✗") : o.kind === "cancelled" ? yellow("■") : green("✓")
      const label =
        o.kind === "failed" ? red("failed") : o.kind === "cancelled" ? yellow("cancelled") : o.kind
      text = `${mark} ${name}  ${label}${o.text ? ` ${dim(o.text)}` : ""}`
    } else if (!r.phase) {
      text = `${dim("·")} ${name}  ${dim("waiting")}`
    } else {
      const pct = r.percent !== undefined ? ` ${r.percent}%` : ""
      text = `${cyan(FRAMES[this.frame]!)} ${name}  ${PHASE_TEXT[r.phase]}${r.detail ? ` ${dim(r.detail)}` : ""}${pct}`
    }
    return truncateToWidth(text, width, "…")
  }
}

function padTo(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)))
}

/** Picks the mode from the flags, the terminal and NO_COLOR. */
export function progressMode(
  flags: { json?: boolean | undefined; quiet?: boolean | undefined },
  tty: boolean,
  env: Record<string, string | undefined>,
): ProgressMode {
  if (flags.json) return "json"
  if (flags.quiet) return "quiet"
  if (!tty || env.NO_COLOR || env.TERM === "dumb") return "plain"
  return "tty"
}

/** The first line of an error, short enough for a package's line. */
export function shortReason(error: string): string {
  return error.split("\n")[0]!.trim()
}
