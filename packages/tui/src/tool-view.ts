import {
  type ToolApproval,
  type ToolCallView,
  type ToolDetailLevel,
  type ToolLine,
  type ToolPresenter,
  type ToolRejection,
  type ToolResult,
  toolResultText,
} from "@amira/api"
import { stripAnsi, type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { renderToolLines } from "./diff-view.ts"
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
  /** Who let it run, when it needed approval: a muted trace on its result line. */
  approval?: ToolApproval
}

/** A call still running, as the live region shows it. */
export interface RunningCall {
  name: string
  args: Record<string, unknown>
  startedAt: number
  /** The latest tool.execute.update. */
  partial?: ToolResult
}

/** Most lines of a failure's body in `summary` detail: its start and its end. */
export const FAILURE_LINES = 8
/** Most lines of any other body (e.g. a diff) in `summary` detail. */
export const BODY_LINES = 20
/** Most live output lines under a running call. */
export const RUNNING_LINES = 3

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

/** How a tool no presenter knows is shown: the arguments, the first line of the result and the rest. */
export const fallbackPresenter: Required<ToolPresenter> = {
  summary: (args) => summarizeArgs(args),
  result: (call) => {
    const all = lines(call.text)
    if (!all.length) return "(no output)"
    return all.length > 1 ? `${all[0]} (+${all.length - 1} lines)` : all[0]
  },
  body: (call, { detail }) =>
    call.result.isError || detail === "full"
      ? lines(call.text)
          .slice(1)
          .map((text) => ({ kind: "code", text }))
      : [],
  running: (_args, partial) =>
    partial
      ? lines(toolResultText(partial))
          .filter((l) => l.trim())
          .slice(-RUNNING_LINES)
          .map((text) => ({ kind: "code", text }))
      : [],
}

/** The head of a call after its name, cut to one line. */
export function callSummary(presenter: ToolPresenter | undefined, args: Record<string, unknown>): string {
  const s = attempt(presenter?.summary && (() => presenter.summary!(args)), () =>
    fallbackPresenter.summary(args),
  )
  return oneLine(s)
}

function oneLine(s: string): string {
  return stripAnsi(String(s)).replace(/\s+/g, " ").trim()
}

/** `● name summary`, fitted to `width`, with `right` against the right edge when it fits. */
function headLine(bullet: string, name: string, summary: string, width: number, right = ""): string {
  const left = `${bullet} ${name}${summary ? ` ${summary}` : ""}`
  if (!right) return truncateToWidth(left, width, glyphs.more)
  const room = width - visibleWidth(right) - 1
  if (room < 12) return truncateToWidth(left, width, glyphs.more)
  const cut = truncateToWidth(left, room, glyphs.more)
  return `${cut}${" ".repeat(Math.max(1, width - visibleWidth(cut) - visibleWidth(right)))}${right}`
}

/** Cuts a body to what `detail` shows: failures keep their start and end, the rest its start. */
export function cutBody(body: ToolLine[], detail: ToolDetailLevel, failed: boolean): ToolLine[] {
  if (detail === "collapsed") return []
  if (detail === "full") return body
  const max = failed ? FAILURE_LINES : BODY_LINES
  if (body.length <= max) return body
  if (!failed) {
    return [
      ...body.slice(0, max - 1),
      { kind: "muted", text: `${glyphs.more} ${body.length - max + 1} more lines` },
    ]
  }
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return [
    ...body.slice(0, head),
    { kind: "muted", text: `${glyphs.more} ${body.length - head - tail} more lines` },
    ...body.slice(body.length - tail),
  ]
}

/**
 * The committed lines of a finished call: its head, a result line and, as `detail` allows, a
 * body. A call that did not run to completion (interrupted, blocked, unknown, invalid) is
 * muted with its own marker rather than a failure's red cross.
 */
export function finishedToolLines(
  theme: Theme,
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
  detail: ToolDetailLevel,
  width: number,
): string[] {
  const outcome = outcomeOf(call)
  const view: ToolCallView = {
    args: call.args,
    result: call.result,
    text: toolResultText(call.result),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    ...(call.rejected ? { rejected: call.rejected } : {}),
  }
  const summary = callSummary(presenter, call.args)
  const ran = outcome === "done" || outcome === "failed"
  const bullet =
    outcome === "done"
      ? theme.success(BULLETS.done)
      : outcome === "failed"
        ? theme.error(BULLETS.failed)
        : theme.muted(BULLETS[outcome])
  const name = ran ? theme.accent(call.name) : theme.muted(call.name)
  const out = [headLine(bullet, name, ran ? summary : theme.muted(summary), width)]

  let result: string
  if (outcome === "interrupted") result = "interrupted"
  else if (!ran) result = lines(view.text)[0] ?? outcome
  else
    result = oneLine(
      attempt(presenter?.result && (() => presenter.result!(view)), () => fallbackPresenter.result(view)) ??
        "",
    )
  const style = outcome === "failed" ? theme.error : theme.muted
  const approval =
    call.approval === "user"
      ? " · allowed by you"
      : call.approval === "rule"
        ? " · allowed · session rule"
        : ""
  const time = `${
    call.durationMs !== undefined && call.durationMs >= 1000 ? ` · ${formatDuration(call.durationMs)}` : ""
  }${approval}`
  const prefix = `  ${theme.muted(glyphs.result)} `
  const room = Math.max(8, width - visibleWidth(prefix) - visibleWidth(time))
  out.push(`${prefix}${style(truncateToWidth(result, room, glyphs.more))}${theme.muted(time)}`)

  if (ran && detail !== "collapsed") {
    const opts = { detail, width: width - BODY_INDENT.length }
    const body = attempt(presenter?.body && (() => presenter.body!(view, opts)), () =>
      fallbackPresenter.body(view, opts),
    )
    out.push(...renderToolLines(cutBody(body, detail, outcome === "failed"), theme, width, BODY_INDENT))
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
  const head = headLine(theme.accent(glyphs.toolRunning), theme.accent(call.name), summary, width, right)
  const live = attempt(presenter?.running && (() => presenter.running!(call.args, call.partial)), () =>
    fallbackPresenter.running(call.args, call.partial),
  ).slice(-RUNNING_LINES)
  const prefix = `  ${theme.muted(glyphs.output)} `
  return [
    head,
    ...live.map((l) => truncateToWidth(`${prefix}${theme.muted(oneLineRaw(l.text))}`, width, glyphs.more)),
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

function oneLineRaw(s: string): string {
  return stripAnsi(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/\t/g, "  ")
}
