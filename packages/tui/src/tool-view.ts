import {
  ARTIFACT_HEADER,
  clipMiddle,
  DEFAULT_SHELL_OUTPUT_LINES,
  OMITTED_NOTE,
  plural,
  previewNoteLine,
  type ToolApproval,
  type ToolBodyOptions,
  type ToolCallView,
  type ToolDetailLevel,
  type ToolExploration,
  type ToolLine,
  type ToolPresenter,
  type ToolRejection,
  type ToolResult,
  toolResultText,
  UNSAVED_HEADER,
} from "@amira/api"
import {
  bold,
  type StyleFn,
  stripAnsi,
  type Theme,
  themeToken,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { renderToolLines, type ToolLayoutLine, terminalText, type ViewMarkers } from "./diff-view.ts"
import { formatDuration, formatElapsed, stampRows, summarizeArgs, timestampRoom } from "./format.ts"
import { asciiGlyphs, glyphs, viewSeparator } from "./glyphs.ts"
import { CONTENT_INSET, MARKER_WIDTH, markerPrefix } from "./grid.ts"

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

/** How finished calls are shown besides their detail level: the user's settings. */
export interface ToolViewOptions {
  /**
   * How many of its last output lines a successful shell command shows at `summary` detail
   * (tui.shellOutputLines); 0 shows none.
   */
  outputLines?: number
  /** The last tool in its step/turn: close the branch and leave its continuation blank. */
  last?: boolean
  /** An unfolded exploration keeps each result below its own head. */
  expanded?: boolean
  /** Only the first visible assistant row of a turn owns a clock. */
  timestamp?: number
  /** Host-only continuation boundaries, with the separator removed by wrapping. */
  onWrap?: (row: number, join: "" | " ") => void
  /** Host-only content columns, excluding only chrome this renderer added. */
  onRow?: (row: number, from: number) => void
  /**
   * Between the parts of a host-composed summary. Views working from an ASCII glyph set pass
   * an ASCII one; other callers keep the middle dot these summaries have always used.
   */
  separator?: string
  /** Ends a summary cut in its middle. Views pass their own marker so ASCII stays ASCII. */
  ellipsis?: string
  /** View decorations for delegated tool bodies (diff gaps and cuts); absent keeps the old ones. */
  markers?: ViewMarkers
}

/** Most lines of a failure's body in `summary` detail: its start and its end. */
export const FAILURE_LINES = 8
/** Most lines of any other body (e.g. a diff) in `summary` detail. */
export const BODY_LINES = 20
/** Most live output lines under a running call. */
export const RUNNING_LINES = 3
/** Shared live-output budget; running heads always remain visible. */
export const RUNNING_TOTAL_LINES = 6

/** Split the preview budget in call order, with at most three rows per streaming call. */
export function runningOutputLimit(index: number, count: number): number {
  if (count <= 0) return RUNNING_LINES
  return Math.min(
    RUNNING_LINES,
    Math.floor(RUNNING_TOTAL_LINES / count) + (index < RUNNING_TOTAL_LINES % count ? 1 : 0),
  )
}

/** Output lines a successful shell command shows by default (the shellOutputLines default, kept equal to RUNNING_LINES by a test). */
export const OUTPUT_LINES = DEFAULT_SHELL_OUTPUT_LINES

/** The tree rail continues beside results, wrapped diffs and live output until the last tool. */
function treeHead(theme: Theme, last = false): string {
  const arm = last ? glyphs.treeLast : glyphs.treeBranch
  const cells = Math.max(visibleWidth(glyphs.treeBranch), visibleWidth(glyphs.treeLast))
  return theme.muted(arm + " ".repeat(cells - visibleWidth(arm)))
}

/** Internal rail prefix for a tool's sub-agent rows as well as its own output. */
export function treeContinuation(theme: Theme, last = false): string {
  if (last) return CONTENT_INSET
  const pipe = theme.muted(glyphs.treePipe)
  return markerPrefix(pipe)
}

type Outcome = "done" | "failed" | "interrupted" | "blocked" | "unknownTool" | "invalidArgs"

function outcomeOf(call: FinishedCall): Outcome {
  if (call.rejected === "aborted") return "interrupted"
  if (call.rejected) return call.rejected
  if (call.result.isError) return call.interrupted ? "interrupted" : "failed"
  return "done"
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

/**
 * A preview note as a view draws it. An ASCII view cannot show the note's typographic marks,
 * so it gets the same information with ASCII ones; other views keep the API's text.
 */
function viewNoteLine(text: string): ToolLine | undefined {
  if (!asciiGlyphs()) return previewNoteLine(text)
  const sep = viewSeparator()
  const saved = ARTIFACT_HEADER.exec(text)
  if (saved)
    return {
      kind: "muted",
      text: `... output saved as ${saved[1]} ${sep} ${saved[3]} lines ${sep} ${saved[2]} chars`,
    }
  const unsaved = UNSAVED_HEADER.exec(text)
  if (unsaved)
    return { kind: "muted", text: `... output too long (${unsaved[2]} lines); only a preview was kept` }
  const cut = OMITTED_NOTE.exec(text)
  if (cut) return { kind: "muted", text: `... ${cut[1]} lines omitted (${cut[3]}-${cut[4]})` }
  return undefined
}

/** The generic body; an ASCII view draws its preview notes in ASCII. */
function fallbackBody(call: ToolCallView, opts: ToolBodyOptions, markers?: ViewMarkers): ToolLine[] {
  if (!markers || !asciiGlyphs()) return fallbackPresenter.body(call, opts)
  if (opts.detail === "full" && !call.result.isError && jsonSummary(call.text))
    return lines(call.text).map((text) => ({ kind: "code", text }))
  if (!call.result.isError && opts.detail !== "full") return []
  return lines(call.text)
    .slice(1)
    .map((text) => viewNoteLine(text) ?? { kind: "code", text })
}

/** The generic result, with `separator` for views that draw host-composed labels in ASCII. */
function fallbackResult(call: ToolCallView, separator = "·"): string {
  const json = !call.result.isError && jsonSummary(call.text)
  if (json) return json
  const all = lines(call.text)
  if (!all.length) return "no output"
  // A large output saved as an artifact: what the preview stands for, not its header.
  const saved = ARTIFACT_HEADER.exec(all[0]!)
  if (saved) return `${saved[3]} lines ${separator} saved as ${saved[1]}`
  return all.length > 1 ? `${all[0]} (+${plural(all.length - 1, "line")})` : all[0]!
}

/** How a tool no presenter knows is shown: the arguments, the first line of the result and the rest. */
export const fallbackPresenter: Required<Omit<ToolPresenter, "explore" | "verbs">> = {
  summary: (args) => summarizeArgs(args),
  result: (call) => fallbackResult(call),
  body: (call, { detail }) => {
    if (detail === "full" && !call.result.isError && jsonSummary(call.text))
      return lines(call.text).map((text) => ({ kind: "code", text }))
    return call.result.isError || detail === "full"
      ? lines(call.text)
          .slice(1)
          .map((text) => previewNoteLine(text) ?? { kind: "code", text })
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

/** The marker a view clips with: its own when it has one, else the configured one. */
const cutMarker = (opts: Pick<ToolViewOptions, "markers">): string => opts.markers?.ellipsis ?? glyphs.more

/** The head of a call after its name, on one line, paths under the working directory relative. */
export function callSummary(
  presenter: ToolPresenter | undefined,
  args: Record<string, unknown>,
  separator = "·",
  ellipsis = "…",
): string {
  const s = attempt(presenter?.summary && (() => presenter.summary!(args)), () =>
    summarizeArgs(args, 80, separator, ellipsis),
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

/** The argument's semantic role, without coloring a tool's plain-text presenter output. */
function summaryStyle(theme: Theme, args: Record<string, unknown>): StyleFn {
  if (typeof args.command === "string") return themeToken(theme, "command") ?? theme.text
  if (["path", "file_path", "filePath"].some((key) => typeof args[key] === "string"))
    return themeToken(theme, "path") ?? theme.text
  return theme.text
}

/**
 * `├ name summary`, fitted to `width`, with a two-cell gap before `right` at the right edge.
 * A summary too long is cut in its middle, so a path keeps its file name and a command its end.
 */
function headLine(
  theme: Theme,
  bullet: string,
  name: string,
  summary: string,
  width: number,
  opts: {
    right?: string
    muted?: boolean
    verb?: string
    nameStyle?: StyleFn
    summaryStyle?: StyleFn
    ellipsis?: string
    /** Ends the head when it is cut to the width. */
    cut?: string
  } = {},
): string {
  const verb = opts.verb ? oneLine(opts.verb) : ""
  const label = verb
    ? (opts.nameStyle ?? ((s) => bold(theme.text(s))))(verb)
    : nameLabel(theme, name, opts.nameStyle ?? themeToken(theme, "fg2") ?? theme.text)
  const right = opts.right ?? ""
  const reserved = right ? visibleWidth(right) + 2 : 0
  const fitsRight = right !== "" && width - reserved >= 12
  const room = (fitsRight ? width - reserved : width) - visibleWidth(`${markerPrefix(bullet)}${label} `)
  const shown = summary && room >= 8 ? clipMiddle(summary, room, opts.ellipsis) : summary
  const style = opts.muted ? theme.muted : (opts.summaryStyle ?? theme.text)
  const text = shown ? ` ${style(shown)}` : ""
  const left = `${markerPrefix(bullet)}${label}${text}`
  const more = opts.cut ?? glyphs.more
  if (!fitsRight) return truncateToWidth(left, width, more)
  const cut = truncateToWidth(left, width - reserved, more)
  return `${cut}${" ".repeat(Math.max(2, width - visibleWidth(cut) - visibleWidth(right)))}${right}`
}

/** "… 3 more lines", said the same way everywhere a body is cut. Views pass their own marker. */
export function moreLines(n: number, marker = glyphs.more): string {
  return `${marker} ${plural(n, "more line")}`
}

/** Cuts a body to what `detail` shows: failures keep their start and end, the rest its start. */
export function cutBody(
  body: ToolLine[],
  detail: ToolDetailLevel,
  failed: boolean,
  marker = glyphs.more,
): ToolLine[] {
  if (detail === "collapsed") return []
  if (detail === "full") return body
  const max = failed ? FAILURE_LINES : BODY_LINES
  if (body.length <= max) return body
  if (!failed)
    return [...body.slice(0, max - 1), { kind: "muted", text: moreLines(body.length - max + 1, marker) }]
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return [
    ...body.slice(0, head),
    { kind: "muted", text: moreLines(body.length - head - tail, marker) },
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

/** A presenter's result, or the generic one, keeping real line breaks. */
function presentedResult(presenter: ToolPresenter | undefined, view: ToolCallView, separator = "·"): string {
  const result =
    attempt(presenter?.result && (() => presenter.result!(view)), () => fallbackResult(view, separator)) ?? ""
  return stripAnsi(String(result)).split(/\r?\n/).map(oneLine).join("\n").trim()
}

function outcomeMark(outcome: Outcome): string {
  switch (outcome) {
    case "done":
      return glyphs.toolDone
    case "failed":
      return glyphs.toolFailed
    case "interrupted":
      return glyphs.toolInterrupted
    case "blocked":
      return glyphs.toolBlocked
    case "unknownTool":
      return glyphs.toolUnknown
    case "invalidArgs":
      return glyphs.toolInvalid
  }
}

/** Only a standalone current mark counts, not an ASCII word beginning with e.g. "v". */
function hasMark(result: string, mark: string): boolean {
  return result === mark || result.startsWith(`${mark} `) || result.startsWith(`${mark}\n`)
}

function withoutMark(result: string, mark: string): string {
  return hasMark(result, mark) ? result.slice(mark.length).trimStart() : result
}

const DIFF_COUNTS = /(^|\s)(\+\d+)\s+(?:\/\s*)?([-−]\d+)(?=\s|$)/

/** Diff counts carry their own meaning instead of inheriting the successful call's green. */
function diffResult(result: string, theme: Theme): string {
  const stats = new RegExp(DIFF_COUNTS, "g")
  let at = 0
  let shown = ""
  for (const match of result.matchAll(stats)) {
    shown += theme.success(result.slice(at, match.index) + match[1])
    shown += theme.success(match[2]!) + theme.muted(" / ") + theme.error(match[3]!)
    at = match.index + match[0].length
  }
  return at ? shown + theme.success(result.slice(at)) : theme.success(result)
}

/**
 * The committed lines of a finished call: its head with a fitting compact result, otherwise
 * continuation result rows, and, as `detail` allows, a body. A call that did not run to
 * completion (interrupted, blocked, unknown, invalid) is
 * muted rather than shown as a failure; one interrupted while it ran keeps what it had
 * printed, as a failure does. A failure whose presenter shows nothing under
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
  const mark = outcomeMark(outcome)
  const view = callView(call)
  const summary = callSummary(presenter, call.args, opts.separator, opts.ellipsis)
  const ran = outcome === "done" || outcome === "failed"
  // Interrupted while it ran (not before it started): what it printed so far still shows.
  const cutShort = outcome === "interrupted" && call.rejected !== "aborted" && view.text !== ""
  const continuation = treeContinuation(theme, opts.last)
  const headWidth = timestampRoom(width, opts.timestamp)
  const out = [
    headLine(theme, treeHead(theme, opts.last), call.name, summary, headWidth, {
      muted: !ran,
      verb: ran || cutShort ? presenter?.verbs?.past : undefined,
      summaryStyle: summaryStyle(theme, call.args),
      ellipsis: opts.ellipsis,
      cut: cutMarker(opts),
      ...(ran ? {} : { nameStyle: theme.muted }),
    }),
  ]

  opts.onRow?.(0, MARKER_WIDTH)

  let result: string
  /** The result line says what the presenter made of a call cut short. */
  let saidResult = false
  if (outcome === "interrupted") {
    // What its presenter makes of it; without one, its output shows under it instead.
    const said =
      cutShort && presenter?.result ? withoutMark(presentedResult(presenter, view, opts.separator), mark) : ""
    saidResult = said !== ""
    result = !said
      ? "interrupted"
      : said.startsWith("interrupted")
        ? said
        : `interrupted ${glyphs.separator} ${said}`
  } else if (!ran) result = lines(view.text).join("\n") || outcome
  else result = presentedResult(presenter, view, opts.separator)
  const style = outcome === "done" ? theme.success : outcome === "failed" ? theme.error : theme.muted
  const approval =
    call.approval === "user"
      ? ` ${glyphs.separator} allowed by you`
      : call.approval === "rule"
        ? ` ${glyphs.separator} allowed ${glyphs.separator} session rule`
        : ""
  const time = `${
    call.durationMs !== undefined && call.durationMs >= 1000
      ? ` ${glyphs.separator} ${formatDuration(call.durationMs)}`
      : ""
  }${approval}`
  const prefix = continuation
  const failed = outcome !== "done"
  let body: ToolLayoutLine[] = []
  if ((ran || cutShort) && detail !== "collapsed") {
    const bodyOpts = {
      detail,
      width: Math.max(0, width - visibleWidth(prefix)),
      ...(opts.outputLines !== undefined ? { outputLines: opts.outputLines } : {}),
    }
    // Cut short with no result line of its own to say it: all its output is the body.
    const output = (): ToolLine[] => lines(view.text).map((text) => ({ kind: "code", text }))
    body =
      cutShort && !saidResult
        ? output()
        : attempt(presenter?.body && (() => presenter.body!(view, bodyOpts)), () =>
            fallbackBody(view, bodyOpts, opts.markers),
          )
    // The presenter keeps a failure's lines to itself (it said why in the result, or not):
    // the output is the only way to see what went wrong.
    if (failed && !body.length) body = cutShort ? output() : fallbackBody(view, bodyOpts, opts.markers)
    // A one-line output the result line already says (e.g. "Aborted by the user …") is not
    // said twice.
    body = body.flatMap(({ text, marker, description, ...line }) => {
      const rows = text.split(/\r?\n/)
      const effectiveWrap = line.wrap || description !== undefined
      const hangingIndent = marker ? visibleWidth(`${glyphs[marker]} `) : 0
      return rows.map((text, i) => ({
        ...line,
        text,
        ...(effectiveWrap ? { wrap: true } : {}),
        ...(i === 0 && marker !== undefined ? { marker } : {}),
        ...(i > 0 && hangingIndent ? { hangingIndent } : {}),
        ...(i === rows.length - 1 && description !== undefined ? { description } : {}),
      }))
    })
    const single = body.length === 1 ? body[0] : undefined
    // Only plain output can repeat the result. Choice metadata, gutters and explicit styles
    // carry information even when their label is the same as the result text.
    if (
      single &&
      (single.kind === "text" || single.kind === "code") &&
      Object.keys(single).every((key) => key === "kind" || key === "text") &&
      withoutMark(single.text.trim(), mark) === withoutMark(result.trim(), mark)
    )
      body = []
  }

  const diffOutcome = outcome === "done" && typeof call.args.command !== "string" && DIFF_COUNTS.test(result)
  const marked = diffOutcome
    ? withoutMark(result, mark)
    : hasMark(result, mark)
      ? result
      : `${mark}${result ? ` ${result}` : ""}`
  const resultText = `${outcome === "done" ? diffResult(marked, theme) : style(marked)}${theme.muted(time)}`
  // A compact result may share the head even when output follows. Diff/output rows and
  // multiline/expanded results retain their rails below; callers insert child rows at 1.
  if (
    detail !== "full" &&
    !opts.expanded &&
    !marked.includes("\n") &&
    visibleWidth(out[0]!) + 2 + visibleWidth(resultText) <= headWidth
  ) {
    out[0] = `${out[0]!}  ${resultText}`
  } else {
    const rows = wrapText(resultText, Math.max(1, width - visibleWidth(prefix)))
    const resultRows = cutBody(
      rows.map((text) => ({ kind: "text", text })),
      detail === "full" ? "full" : "summary",
      failed,
      cutMarker(opts),
    )
    for (const [i, line] of resultRows.entries()) {
      const markWidth = i === 0 && !diffOutcome ? visibleWidth(mark) + (result ? 1 : 0) : 0
      opts.onRow?.(out.length, visibleWidth(prefix) + markWidth)
      out.push(
        truncateToWidth(
          `${prefix}${line.kind === "muted" ? theme.muted(line.text) : line.text}`,
          width,
          cutMarker(opts),
        ),
      )
    }
  }
  const bodyOffset = out.length
  const onWrap = opts.onWrap && ((row: number, join: "" | " ") => opts.onWrap!(bodyOffset + row, join))
  const onRow =
    opts.onRow &&
    ((row: number, from: number) => opts.onRow!(bodyOffset + row, visibleWidth(continuation) + from))
  const bodyRows = renderToolLines(
    cutBody(body, detail, failed, cutMarker(opts)),
    theme,
    Math.max(0, width - visibleWidth(continuation)),
    "",
    onWrap,
    onRow,
    opts.markers,
  )
  const cut = opts.markers?.ellipsis ?? glyphs.more
  for (const line of bodyRows) out.push(truncateToWidth(`${continuation}${line}`, width, cut))
  return stampRows(out, theme, width, opts.timestamp)
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
  opts: Pick<ToolViewOptions, "last" | "timestamp" | "onRow" | "separator" | "ellipsis" | "markers"> & {
    liveOutputLines?: number
  } = {},
): string[] {
  const summary = callSummary(presenter, call.args, opts.separator, opts.ellipsis)
  const right = theme.muted(formatElapsed(now - call.startedAt))
  const head = headLine(
    theme,
    theme.accent(spinner),
    call.name,
    summary,
    timestampRoom(width, opts.timestamp),
    {
      right,
      verb: presenter?.verbs?.running,
      summaryStyle: summaryStyle(theme, call.args),
      ellipsis: opts.ellipsis,
      cut: cutMarker(opts),
    },
  )
  const limit = Math.max(0, Math.min(RUNNING_LINES, opts.liveOutputLines ?? RUNNING_LINES))
  const live =
    limit && call.partial
      ? attempt(presenter?.running && (() => presenter.running!(call.args, call.partial)), () =>
          fallbackPresenter.running(call.args, call.partial),
        ).slice(-limit)
      : []
  const prefix = markerPrefix(theme.muted(glyphs.treePipe))
  opts.onRow?.(0, visibleWidth(`${spinner} `))
  live.forEach((_, i) => {
    opts.onRow?.(i + 1, visibleWidth(prefix))
  })
  return stampRows(
    [
      head,
      ...live.map((l) =>
        truncateToWidth(`${prefix}${theme.muted(terminalText(l.text))}`, width, cutMarker(opts)),
      ),
    ],
    theme,
    width,
    opts.timestamp,
  )
}

/** A finished call waiting for the calls before it to be committed: just its head. */
export function heldToolLine(
  theme: Theme,
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
  width: number,
  opts: Pick<ToolViewOptions, "last" | "timestamp"> = {},
): string {
  return finishedToolLines(theme, presenter, call, "collapsed", width, opts)[0]!
}

/** Built-in exploration without metadata, including provider-hosted and web tools. */
function defaultExploration(call: FinishedCall): ToolExploration | undefined {
  const verbs: Record<string, string> = {
    read: "Read",
    output_read: "Read",
    grep: "Search",
    search: "Search",
    web_search: "Search",
    glob: "Glob",
    list: "List",
    fetch: "Fetch",
    web_fetch: "Fetch",
  }
  if (!Object.hasOwn(verbs, call.name)) return undefined
  let verb = verbs[call.name]
  if (!verb) return undefined
  if (call.name === "web_search" && call.args.url && !call.args.query && !call.args.pattern) verb = "Fetch"
  const keys =
    verb === "Read"
      ? ["path", "file_path", "filePath", "id"]
      : verb === "Search"
        ? ["pattern", "query"]
        : verb === "Glob"
          ? ["pattern"]
          : verb === "List"
            ? ["path"]
            : ["url"]
  const target = keys.map((key) => call.args[key]).find((value) => typeof value === "string")
  if (typeof target !== "string" || !target.trim()) return undefined
  const path = call.args.path ?? call.args.url
  const where = (verb === "Search" || verb === "Glob") && typeof path === "string" ? ` in ${path}` : ""
  return { verb, target: target + where }
}

/** Successful exploration only; a failure, interruption or rejection keeps its own rows. */
export function explorationOf(
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
): ToolExploration | undefined {
  if (call.interrupted || outcomeOf(call) !== "done") return undefined
  try {
    const e = presenter?.explore ? presenter.explore(call.args) : defaultExploration(call)
    if (!e) return undefined
    // Older glob presenters called finding paths "List"; keep glob and directory lists distinct.
    const verb = call.name === "glob" && e.verb === "List" ? "Glob" : oneLine(e.verb)
    const target = relativePaths(oneLine(e.target))
    return verb && target ? { verb, target } : undefined
  } catch {
    return undefined
  }
}

/** Past-tense verbs and the things counted, rather than e.g. "1 searches". */
const EXPLORATION_LABELS: Record<string, [string, string, string?]> = {
  read: ["Read", "file"],
  search: ["Searched", "pattern"],
  glob: ["Globbed", "pattern"],
  list: ["Listed", "directory", "directories"],
  fetch: ["Fetched", "page"],
}

/** One muted, count-only row in first-action order; counts are calls, not unique targets. */
export function exploredLine(
  theme: Theme,
  explored: ToolExploration[],
  width: number,
  opts: Pick<ToolViewOptions, "last" | "expanded" | "markers"> = {},
): string {
  const byVerb = new Map<string, number>()
  for (const e of explored) {
    const verb = Object.hasOwn(EXPLORATION_LABELS, e.verb.toLowerCase()) ? e.verb.toLowerCase() : e.verb
    byVerb.set(verb, (byVerb.get(verb) ?? 0) + 1)
  }
  const s = theme.muted(` ${glyphs.separator} `)
  const lead = markerPrefix(treeHead(theme, opts.last))
  const tail = opts.expanded ? "" : `  ${theme.muted(glyphs.folded)}`
  const parts = [...byVerb].map(([verb, count]) => {
    const [label, noun, many] = Object.hasOwn(EXPLORATION_LABELS, verb)
      ? EXPLORATION_LABELS[verb]!
      : [verb, "target"]
    return theme.muted(`${label} ${plural(count, noun, many)}`)
  })
  const room = Math.max(0, width - visibleWidth(tail))
  const more = cutMarker(opts)
  return truncateToWidth(truncateToWidth(lead + parts.join(s), room, more) + tail, width, more)
}

/** Successful exploring calls in a row: one folded row, or each call with its full result and output. */
export function exploredLines(
  theme: Theme,
  calls: { call: FinishedCall; presenter: ToolPresenter | undefined }[],
  expanded: boolean,
  detail: ToolDetailLevel,
  width: number,
  opts: ToolViewOptions = {},
): string[] {
  const explored = calls.flatMap(({ call, presenter }) => explorationOf(presenter, call) ?? [])
  // Do not hide a failed or otherwise ineligible call, even if a caller supplies one by mistake.
  const eligible = explored.length === calls.length
  if (eligible && !expanded) {
    opts.onRow?.(0, MARKER_WIDTH)
    return stampRows(
      [exploredLine(theme, explored, timestampRoom(width, opts.timestamp), opts)],
      theme,
      width,
      opts.timestamp,
    )
  }
  let offset = 0
  return calls.flatMap(({ call, presenter }, i) => {
    const start = offset
    const rows = finishedToolLines(theme, presenter, call, expanded ? "full" : detail, width, {
      ...opts,
      timestamp: i === 0 ? opts.timestamp : undefined,
      ...(eligible && expanded ? { expanded: true } : {}),
      last: i === calls.length - 1 && opts.last,
      onRow: opts.onRow && ((row, from) => opts.onRow!(start + row, from)),
      onWrap: opts.onWrap && ((row, join) => opts.onWrap!(start + row, join)),
    })
    offset += rows.length
    return rows
  })
}
