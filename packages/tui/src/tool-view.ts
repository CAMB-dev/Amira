import {
  clipMiddle,
  plural,
  type ToolCallView,
  type ToolDetailLevel,
  type ToolExploration,
  type ToolLine,
  type ToolPresenter,
  type ToolRejection,
  type ToolResult,
  toolResultText,
} from "@amira/api"
import { stripAnsi, type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { renderToolLines, terminalText } from "./diff-view.ts"
import { formatDuration, formatElapsed, summarizeArgs } from "./format.ts"
import { glyphs } from "./glyphs.ts"

/** Where the TUI finds the presenter of a tool; the core's ToolRendererRegistry is one. */
export interface PresenterSource {
  get(toolName: string): ToolPresenter<any, any> | undefined
}

/** A finished tool call. */
export interface FinishedCall {
  name: string
  args: Record<string, unknown>
  result: ToolResult
  /** Unknown for calls of a resumed session. */
  durationMs?: number
  rejected?: ToolRejection
  /** The user interrupted the turn while this call ran, so its failure is not the tool's. */
  interrupted?: boolean
}

/** A call still running, as the live region shows it. */
export interface RunningCall {
  name: string
  args: Record<string, unknown>
  startedAt: number
  /** The latest tool.execute.update. */
  partial?: ToolResult
}

/** How finished calls are shown besides their detail level: the user's settings. */
export interface ToolViewOptions {
  /**
   * How many of its last output lines a successful shell command shows at `summary` detail
   * (tui.shellOutputLines); 0 shows none.
   */
  outputLines?: number
}

/** Most lines of a failure's body in `summary` detail: its start and its end. */
export const FAILURE_LINES = 8
/** Most lines of any other body (e.g. a diff) in `summary` detail. */
export const BODY_LINES = 20
/** Most live output lines under a running call. */
export const RUNNING_LINES = 3
/** Output lines a successful shell command shows by default: as many as while it ran. */
export const OUTPUT_LINES = RUNNING_LINES

/** Indent of a call's body, under the text of its result line. */
const BODY_INDENT = "    "

type Outcome = "done" | "failed" | "interrupted" | "blocked" | "unknownTool" | "invalidArgs"

function outcomeOf(call: FinishedCall): Outcome {
  if (call.rejected === "aborted") return "interrupted"
  if (call.rejected) return call.rejected
  if (call.result.isError) return call.interrupted ? "interrupted" : "failed"
  return "done"
}

const BULLETS: Record<Outcome, string> = {
  done: glyphs.toolDone,
  failed: glyphs.toolFailed,
  interrupted: glyphs.toolInterrupted,
  blocked: glyphs.toolBlocked,
  unknownTool: glyphs.toolUnknown,
  invalidArgs: glyphs.toolInvalid,
}

/** Calls a presenter's method; a missing method, a throw or undefined means the fallback. */
function attempt<T>(fn: (() => T | undefined) | undefined, fallback: () => T): T {
  if (!fn) return fallback()
  try {
    return fn() ?? fallback()
  } catch {
    return fallback()
  }
}

function lines(text: string): string[] {
  return text ? stripAnsi(text).split("\n") : []
}

/** Lists and objects a tool (an MCP server's, say) answered with, summed up in a few words. */
function jsonSummary(text: string): string | undefined {
  const t = text.trim()
  if (!/^[[{]/.test(t)) return undefined
  let value: unknown
  try {
    value = JSON.parse(t)
  } catch {
    return undefined
  }
  if (Array.isArray(value)) return plural(value.length, "item")
  if (!value || typeof value !== "object") return undefined
  const entries = Object.entries(value)
  // An object around one list (`{ "items": [...], "total": 3 }`): the list is what it is about.
  const lists = entries.filter(([, v]) => Array.isArray(v))
  if (lists.length === 1) {
    const [key, list] = lists[0]!
    return `${plural((list as unknown[]).length, "item")} (${key})`
  }
  return plural(entries.length, "field")
}

/** How a tool no presenter knows is shown: the arguments, the first line of the result and the rest. */
export const fallbackPresenter: Required<Omit<ToolPresenter, "explore">> = {
  summary: (args) => summarizeArgs(args),
  result: (call) => {
    const json = !call.result.isError && jsonSummary(call.text)
    if (json) return json
    const all = lines(call.text)
    if (!all.length) return "no output"
    return all.length > 1 ? `${all[0]} (+${plural(all.length - 1, "line")})` : all[0]
  },
  body: (call, { detail }) => {
    if (detail === "full" && !call.result.isError && jsonSummary(call.text))
      return lines(call.text).map((text) => ({ kind: "code", text }))
    return call.result.isError || detail === "full"
      ? lines(call.text)
          .slice(1)
          .map((text) => ({ kind: "code", text }))
      : []
  },
  running: (_args, partial) =>
    partial
      ? lines(toolResultText(partial))
          .filter((l) => l.trim())
          .slice(-RUNNING_LINES)
          .map((text) => ({ kind: "code", text }))
      : [],
}

/** The working directory as it starts a path in a call's head, in each separator. */
function cwdPrefixes(): string[] {
  const cwd = process.cwd().replace(/[\\/]+$/, "")
  // At the root ("/", or "C:" left of "C:\") every path is under it: nothing is worth dropping.
  if (!/[\\/]/.test(cwd)) return []
  const slashed = cwd.replaceAll("\\", "/")
  return [...new Set([`${cwd}/`, `${cwd}\\`, `${slashed}/`])]
}

/**
 * Paths under the working directory, relative to it: the head has little room. A prefix counts
 * only where a path starts (not inside another path that happens to contain it), and on Windows
 * whatever the case of its letters.
 */
export function relativePaths(
  s: string,
  prefixes = cwdPrefixes(),
  ignoreCase = process.platform === "win32",
): string {
  let out = s
  for (const p of prefixes) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    out = out.replace(new RegExp(`(?<![^\\s"'=(\`])${escaped}`, ignoreCase ? "gi" : "g"), "")
  }
  return out
}

/** The head of a call after its name, on one line, paths under the working directory relative. */
export function callSummary(presenter: ToolPresenter | undefined, args: Record<string, unknown>): string {
  const s = attempt(presenter?.summary && (() => presenter.summary!(args)), () =>
    fallbackPresenter.summary(args),
  )
  return relativePaths(oneLine(s))
}

function oneLine(s: string): string {
  return stripAnsi(String(s)).replace(/\s+/g, " ").trim()
}

/** An MCP tool's name, `mcp__server__tool`, as its server and its own name. */
export function mcpName(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? { server: m[1]!, tool: m[2]! } : undefined
}

/** A tool's name in a head: an MCP tool's as `server · tool`, the server muted. */
function nameLabel(theme: Theme, name: string, style: (s: string) => string): string {
  const mcp = mcpName(name)
  return mcp ? `${theme.muted(`${mcp.server} ${glyphs.separator}`)} ${style(mcp.tool)}` : style(name)
}

/**
 * `● name summary`, fitted to `width`, with `right` against the right edge when it fits. A
 * summary too long is cut in its middle, so a path keeps its file name and a command its end.
 */
function headLine(
  theme: Theme,
  bullet: string,
  name: string,
  summary: string,
  width: number,
  opts: { right?: string; muted?: boolean; nameStyle?: (s: string) => string } = {},
): string {
  const label = nameLabel(theme, name, opts.nameStyle ?? theme.accent)
  const right = opts.right ?? ""
  const reserved = right ? visibleWidth(right) + 1 : 0
  const fitsRight = right !== "" && width - reserved >= 12
  const room = (fitsRight ? width - reserved : width) - visibleWidth(`${bullet} ${label} `)
  const shown = summary && room >= 8 ? clipMiddle(summary, room) : summary
  const text = shown ? ` ${opts.muted ? theme.muted(shown) : shown}` : ""
  const left = `${bullet} ${label}${text}`
  if (!fitsRight) return truncateToWidth(left, width, glyphs.more)
  const cut = truncateToWidth(left, width - reserved, glyphs.more)
  return `${cut}${" ".repeat(Math.max(1, width - visibleWidth(cut) - visibleWidth(right)))}${right}`
}

/** "… 3 more lines", said the same way everywhere a body is cut. */
export function moreLines(n: number): string {
  return `${glyphs.more} ${plural(n, "more line")}`
}

/** Cuts a body to what `detail` shows: failures keep their start and end, the rest its start. */
export function cutBody(body: ToolLine[], detail: ToolDetailLevel, failed: boolean): ToolLine[] {
  if (detail === "collapsed") return []
  if (detail === "full") return body
  const max = failed ? FAILURE_LINES : BODY_LINES
  if (body.length <= max) return body
  if (!failed) return [...body.slice(0, max - 1), { kind: "muted", text: moreLines(body.length - max + 1) }]
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return [
    ...body.slice(0, head),
    { kind: "muted", text: moreLines(body.length - head - tail) },
    ...body.slice(body.length - tail),
  ]
}

/** The call as its presenter sees it. */
function callView(call: FinishedCall): ToolCallView {
  return {
    args: call.args,
    result: call.result,
    text: toolResultText(call.result),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(call.rejected ? { rejected: call.rejected } : {}),
  }
}

/** A presenter's one-line result, or the generic one. */
function presentedResult(presenter: ToolPresenter | undefined, view: ToolCallView): string {
  return oneLine(
    attempt(presenter?.result && (() => presenter.result!(view)), () => fallbackPresenter.result(view)) ?? "",
  )
}

/**
 * The committed lines of a finished call: its head, a result line and, as `detail` allows, a
 * body. A call that did not run to completion (interrupted, blocked, unknown, invalid) is
 * muted with its own marker rather than a failure's red cross; one interrupted while it ran
 * keeps what it had printed, as a failure does. A failure whose presenter shows nothing under
 * it shows its output.
 */
export function finishedToolLines(
  theme: Theme,
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
  detail: ToolDetailLevel,
  width: number,
  opts: ToolViewOptions = {},
): string[] {
  const outcome = outcomeOf(call)
  const view = callView(call)
  const summary = callSummary(presenter, call.args)
  const ran = outcome === "done" || outcome === "failed"
  // Interrupted while it ran (not before it started): what it printed so far still shows.
  const cutShort = outcome === "interrupted" && call.rejected !== "aborted" && view.text !== ""
  const bullet =
    outcome === "done"
      ? theme.success(BULLETS.done)
      : outcome === "failed"
        ? theme.error(BULLETS.failed)
        : theme.muted(BULLETS[outcome])
  const out = [
    headLine(theme, bullet, call.name, summary, width, {
      muted: !ran,
      ...(ran ? {} : { nameStyle: theme.muted }),
    }),
  ]

  let result: string
  /** The result line says what the presenter made of a call cut short. */
  let saidResult = false
  if (outcome === "interrupted") {
    // What its presenter makes of it; without one, its output shows under it instead.
    const said = cutShort && presenter?.result ? presentedResult(presenter, view) : ""
    saidResult = said !== ""
    result = !said
      ? "interrupted"
      : said.startsWith("interrupted")
        ? said
        : `interrupted ${glyphs.separator} ${said}`
  } else if (!ran) result = lines(view.text)[0] ?? outcome
  else result = presentedResult(presenter, view)
  const style = outcome === "failed" ? theme.error : theme.muted
  const time =
    call.durationMs !== undefined && call.durationMs >= 1000
      ? ` ${glyphs.separator} ${formatDuration(call.durationMs)}`
      : ""
  const prefix = `  ${theme.muted(glyphs.result)} `
  const room = width - visibleWidth(prefix) - visibleWidth(time)
  // Too narrow for the time as well: it goes, and the result is cut to what is left.
  const row =
    room >= 8
      ? `${prefix}${style(truncateToWidth(result, room, glyphs.more))}${theme.muted(time)}`
      : truncateToWidth(`${prefix}${style(result)}`, width, glyphs.more)
  out.push(row)

  if ((ran || cutShort) && detail !== "collapsed") {
    const failed = outcome !== "done"
    const bodyOpts = {
      detail,
      width: width - BODY_INDENT.length,
      ...(opts.outputLines !== undefined ? { outputLines: opts.outputLines } : {}),
    }
    // Cut short with no result line of its own to say it: all its output is the body.
    const output = (): ToolLine[] => lines(view.text).map((text) => ({ kind: "code", text }))
    let body =
      cutShort && !saidResult
        ? output()
        : attempt(presenter?.body && (() => presenter.body!(view, bodyOpts)), () =>
            fallbackPresenter.body(view, bodyOpts),
          )
    // The presenter keeps a failure's lines to itself (it said why in the result, or not):
    // the output is the only way to see what went wrong.
    if (failed && !body.length) body = cutShort ? output() : fallbackPresenter.body(view, bodyOpts)
    out.push(...renderToolLines(cutBody(body, detail, failed), theme, width, BODY_INDENT))
  }
  return out
}

export { formatElapsed }

/**
 * A running call in the live region: its head with a spinner and the elapsed time on the
 * right, then the last few lines of its output.
 */
export function runningToolLines(
  theme: Theme,
  presenter: ToolPresenter | undefined,
  call: RunningCall,
  now: number,
  spinner: string,
  width: number,
): string[] {
  const summary = callSummary(presenter, call.args)
  const right = `${theme.accent(spinner)} ${theme.muted(formatElapsed(now - call.startedAt))}`
  const head = headLine(theme, theme.accent(glyphs.toolRunning), call.name, summary, width, { right })
  const live = attempt(presenter?.running && (() => presenter.running!(call.args, call.partial)), () =>
    fallbackPresenter.running(call.args, call.partial),
  ).slice(-RUNNING_LINES)
  const prefix = `  ${theme.muted(glyphs.output)} `
  return [
    head,
    ...live.map((l) => truncateToWidth(`${prefix}${theme.muted(terminalText(l.text))}`, width, glyphs.more)),
  ]
}

/** A finished call waiting for the calls before it to be committed: just its head. */
export function heldToolLine(
  theme: Theme,
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
  width: number,
): string {
  return finishedToolLines(theme, presenter, call, "collapsed", width)[0]!
}

/**
 * What a finished call only looked around for (its presenter's `explore`), when it succeeded:
 * such calls in a row are shown as one "Explored" row. Undefined for any other call.
 */
export function explorationOf(
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
): ToolExploration | undefined {
  if (!presenter?.explore || outcomeOf(call) !== "done") return undefined
  try {
    const e = presenter.explore(call.args)
    return e && { verb: oneLine(e.verb), target: relativePaths(oneLine(e.target)) }
  } catch {
    return undefined
  }
}

/**
 * The one row of successful exploring calls in a row: `● Explored · Read a.ts, b.ts · Search
 * foo`, what was done in the order it was first done, each target once.
 */
export function exploredLine(theme: Theme, explored: ToolExploration[], width: number): string {
  const byVerb = new Map<string, string[]>()
  for (const e of explored) {
    const targets = byVerb.get(e.verb) ?? []
    if (!targets.includes(e.target)) targets.push(e.target)
    byVerb.set(e.verb, targets)
  }
  const s = ` ${glyphs.separator} `
  const what = [...byVerb].map(([verb, targets]) => `${verb} ${targets.join(", ")}`).join(s)
  const line = `${theme.success(glyphs.toolDone)} ${theme.accent("Explored")}${theme.muted(s)}${theme.muted(what)}`
  return truncateToWidth(line, width, glyphs.more)
}

/**
 * Successful exploring calls in a row, as one block: the "Explored" row and, `expanded`, each
 * call under it as `detail` shows calls.
 */
export function exploredLines(
  theme: Theme,
  calls: { call: FinishedCall; presenter: ToolPresenter | undefined }[],
  expanded: boolean,
  detail: ToolDetailLevel,
  width: number,
  opts: ToolViewOptions = {},
): string[] {
  const explored = calls.flatMap(({ call, presenter }) => explorationOf(presenter, call) ?? [])
  const head = exploredLine(theme, explored, width)
  if (!expanded) return [head]
  const inner = Math.max(1, width - 2)
  return [
    head,
    ...calls.flatMap(({ call, presenter }) =>
      finishedToolLines(theme, presenter, call, detail, inner, opts).map((l) => `  ${l}`),
    ),
  ]
}
