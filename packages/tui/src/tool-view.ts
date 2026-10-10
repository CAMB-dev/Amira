import {
  ARTIFACT_HEADER,
  clipMiddle,
  DEFAULT_SHELL_OUTPUT_LINES,
  plural,
  previewNoteLine,
  type ToolApproval,
  type ToolCallView,
  type ToolDetailLevel,
  type ToolExploration,
  type ToolLine,
  type ToolPresenter,
  type ToolRejection,
  type ToolResult,
  toolResultText,
} from "@amira/api"
import {
  type StyleFn,
  stripAnsi,
  type Theme,
  themeToken,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
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
}

/** Most lines of a failure's body in `summary` detail: its start and its end. */
export const FAILURE_LINES = 8
/** Most lines of any other body (e.g. a diff) in `summary` detail. */
export const BODY_LINES = 20
/** Most live output lines under a running call. */
export const RUNNING_LINES = 3
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
  const cells = Math.max(visibleWidth(glyphs.treeBranch), visibleWidth(glyphs.treeLast))
  if (last) return " ".repeat(cells + 2)
  const pipe = theme.muted(glyphs.treePipe)
  return `  ${pipe}${" ".repeat(Math.max(0, cells - visibleWidth(pipe)))}`
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

/** How a tool no presenter knows is shown: the arguments, the first line of the result and the rest. */
export const fallbackPresenter: Required<Omit<ToolPresenter, "explore">> = {
  summary: (args) => summarizeArgs(args),
  result: (call) => {
    const json = !call.result.isError && jsonSummary(call.text)
    if (json) return json
    const all = lines(call.text)
    if (!all.length) return "no output"
    // A large output saved as an artifact: what the preview stands for, not its header.
    const saved = ARTIFACT_HEADER.exec(all[0]!)
    if (saved) return `${saved[3]} lines · saved as ${saved[1]}`
    return all.length > 1 ? `${all[0]} (+${plural(all.length - 1, "line")})` : all[0]
  },
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

/** The argument's semantic role, without coloring a tool's plain-text presenter output. */
function summaryStyle(theme: Theme, args: Record<string, unknown>): StyleFn {
  if (typeof args.command === "string") return themeToken(theme, "command") ?? theme.text
  if (["path", "file_path", "filePath"].some((key) => typeof args[key] === "string"))
    return themeToken(theme, "path") ?? theme.text
  return theme.text
}

/**
 * `├ name summary`, fitted to `width`, with `right` against the right edge when it fits. A
 * summary too long is cut in its middle, so a path keeps its file name and a command its end.
 */
function headLine(
  theme: Theme,
  bullet: string,
  name: string,
  summary: string,
  width: number,
  opts: { right?: string; muted?: boolean; nameStyle?: StyleFn; summaryStyle?: StyleFn } = {},
): string {
  const label = nameLabel(theme, name, opts.nameStyle ?? themeToken(theme, "fg2") ?? theme.text)
  const right = opts.right ?? ""
  const reserved = right ? visibleWidth(right) + 1 : 0
  const fitsRight = right !== "" && width - reserved >= 12
  const room = (fitsRight ? width - reserved : width) - visibleWidth(`  ${bullet} ${label} `)
  const shown = summary && room >= 8 ? clipMiddle(summary, room) : summary
  const style = opts.muted ? theme.muted : (opts.summaryStyle ?? theme.text)
  const text = shown ? ` ${style(shown)}` : ""
  const left = `  ${bullet} ${label}${text}`
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

/** A presenter's result, or the generic one, keeping real line breaks. */
function presentedResult(presenter: ToolPresenter | undefined, view: ToolCallView): string {
  const result =
    attempt(presenter?.result && (() => presenter.result!(view)), () => fallbackPresenter.result(view)) ?? ""
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

/** Diff counts carry their own meaning instead of inheriting the successful call's green. */
function diffResult(result: string, theme: Theme): string {
  const stats = /(^|\s)(\+\d+)(\s+(?:\/\s*)?)([-−]\d+)(?=\s|$)/g
  let at = 0
  let shown = ""
  for (const match of result.matchAll(stats)) {
    shown += theme.success(result.slice(at, match.index) + match[1])
    shown += theme.success(match[2]!) + theme.muted(match[3]!) + theme.error(match[4]!)
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
  const summary = callSummary(presenter, call.args)
  const ran = outcome === "done" || outcome === "failed"
  // Interrupted while it ran (not before it started): what it printed so far still shows.
  const cutShort = outcome === "interrupted" && call.rejected !== "aborted" && view.text !== ""
  const continuation = treeContinuation(theme, opts.last)
  const out = [
    headLine(theme, treeHead(theme, opts.last), call.name, summary, width, {
      muted: !ran,
      summaryStyle: summaryStyle(theme, call.args),
      ...(ran ? {} : { nameStyle: theme.muted }),
    }),
  ]

  let result: string
  /** The result line says what the presenter made of a call cut short. */
  let saidResult = false
  if (outcome === "interrupted") {
    // What its presenter makes of it; without one, its output shows under it instead.
    const said = cutShort && presenter?.result ? withoutMark(presentedResult(presenter, view), mark) : ""
    saidResult = said !== ""
    result = !said
      ? "interrupted"
      : said.startsWith("interrupted")
        ? said
        : `interrupted ${glyphs.separator} ${said}`
  } else if (!ran) result = lines(view.text).join("\n") || outcome
  else result = presentedResult(presenter, view)
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
  const prefix = `${continuation}  `
  const failed = outcome !== "done"
  let body: ToolLine[] = []
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
            fallbackPresenter.body(view, bodyOpts),
          )
    // The presenter keeps a failure's lines to itself (it said why in the result, or not):
    // the output is the only way to see what went wrong.
    if (failed && !body.length) body = cutShort ? output() : fallbackPresenter.body(view, bodyOpts)
    // A one-line output the result line already says (e.g. "Aborted by the user …") is not
    // said twice.
    body = body.flatMap((line) => line.text.split(/\r?\n/).map((text) => ({ ...line, text })))
    if (body.length === 1 && withoutMark(body[0]!.text.trim(), mark) === withoutMark(result.trim(), mark))
      body = []
  }

  const marked = hasMark(result, mark) ? result : `${mark}${result ? ` ${result}` : ""}`
  const resultText = `${outcome === "done" ? diffResult(marked, theme) : style(marked)}${theme.muted(time)}`
  // A compact result may share the head even when output follows. Diff/output rows and
  // multiline/expanded results retain their rails below; callers insert child rows at 1.
  if (
    detail !== "full" &&
    !opts.expanded &&
    !marked.includes("\n") &&
    visibleWidth(out[0]!) + 2 + visibleWidth(resultText) <= width
  ) {
    out[0] = `${out[0]!}  ${resultText}`
  } else {
    const rows = wrapText(resultText, Math.max(1, width - visibleWidth(prefix)))
    out.push(
      ...cutBody(
        rows.map((text) => ({ kind: "text", text })),
        detail === "full" ? "full" : "summary",
        failed,
      ).map((line) =>
        truncateToWidth(
          `${prefix}${line.kind === "muted" ? theme.muted(line.text) : line.text}`,
          width,
          glyphs.more,
        ),
      ),
    )
  }
  out.push(
    ...renderToolLines(
      cutBody(body, detail, failed),
      theme,
      Math.max(0, width - visibleWidth(continuation)),
      "  ",
    ).map((line) => truncateToWidth(`${continuation}${line}`, width, glyphs.more)),
  )
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
  opts: Pick<ToolViewOptions, "last"> = {},
): string[] {
  const summary = callSummary(presenter, call.args)
  const right = theme.muted(formatElapsed(now - call.startedAt))
  const head = headLine(
    theme,
    `${treeHead(theme, opts.last)} ${theme.accent(spinner)}`,
    call.name,
    summary,
    width,
    {
      right,
      summaryStyle: summaryStyle(theme, call.args),
    },
  )
  const live = attempt(presenter?.running && (() => presenter.running!(call.args, call.partial)), () =>
    fallbackPresenter.running(call.args, call.partial),
  ).slice(-RUNNING_LINES)
  const prefix = `${treeContinuation(theme, opts.last)}  `
  const output = themeToken(theme, "fg2") ?? theme.muted
  return [
    head,
    ...live.map((l) =>
      truncateToWidth(
        `${prefix}${(l.kind === "code" ? output : theme.muted)(terminalText(l.text))}`,
        width,
        glyphs.more,
      ),
    ),
  ]
}

/** A finished call waiting for the calls before it to be committed: just its head. */
export function heldToolLine(
  theme: Theme,
  presenter: ToolPresenter | undefined,
  call: FinishedCall,
  width: number,
  opts: Pick<ToolViewOptions, "last"> = {},
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

/** One counted row, in first-action order; counts are calls, with targets included when they fit. */
export function exploredLine(
  theme: Theme,
  explored: ToolExploration[],
  width: number,
  opts: Pick<ToolViewOptions, "last" | "expanded"> = {},
): string {
  const byVerb = new Map<string, string[]>()
  for (const e of explored) {
    const verb = Object.hasOwn(EXPLORATION_LABELS, e.verb.toLowerCase()) ? e.verb.toLowerCase() : e.verb
    const targets = byVerb.get(verb) ?? []
    targets.push(e.target)
    byVerb.set(verb, targets)
  }
  const s = theme.muted(` ${glyphs.separator} `)
  const verbStyle = themeToken(theme, "fg2") ?? theme.text
  const targetStyle = themeToken(theme, "path") ?? theme.text
  const lead = `  ${treeHead(theme, opts.last)} `
  const tail = opts.expanded ? "" : `  ${theme.muted(glyphs.folded)}`
  const entries = [...byVerb].map(([verb, targets]) => {
    const [label, noun, many] = Object.hasOwn(EXPLORATION_LABELS, verb)
      ? EXPLORATION_LABELS[verb]!
      : [verb, "target"]
    return { count: verbStyle(`${label} ${plural(targets.length, noun, many)}`), targets }
  })
  const parts = entries.map((entry) => entry.count)
  for (const [i, entry] of entries.entries()) {
    const listed = `${entry.count} ${targetStyle(`(${[...new Set(entry.targets)].join(", ")})`)}`
    const candidate = [...parts]
    candidate[i] = listed
    if (visibleWidth(lead + candidate.join(s) + tail) <= width) parts[i] = listed
  }
  const room = Math.max(0, width - visibleWidth(tail))
  return truncateToWidth(truncateToWidth(lead + parts.join(s), room, glyphs.more) + tail, width, glyphs.more)
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
  if (explored.length !== calls.length)
    return calls.flatMap(({ call, presenter }, i) =>
      finishedToolLines(theme, presenter, call, expanded ? "full" : detail, width, {
        ...opts,
        last: i === calls.length - 1 && opts.last,
      }),
    )
  if (!expanded) return [exploredLine(theme, explored, width, opts)]
  return calls.flatMap(({ call, presenter }, i) =>
    finishedToolLines(theme, presenter, call, "full", width, {
      ...opts,
      expanded: true,
      last: i === calls.length - 1 && opts.last,
    }),
  )
}
