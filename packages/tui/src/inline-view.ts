import { type AnyEvent, type Message, plural, type ToolDetailLevel, type ToolPresenter } from "@amira/api"
import {
  FullScreenRenderer,
  LiveRenderer,
  MarkdownStream,
  type RenderContext,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import {
  commandEchoLines,
  formatElapsed,
  reasoningLines,
  replyRows,
  subagentEndLine,
  treeLayout,
  userLines,
} from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { historyLines } from "./history.ts"
import { inlineNodes } from "./markdown-nodes.ts"
import {
  backgroundLabel,
  childrenOf,
  compactGroup,
  endNode,
  isActive,
  rootCall as rootCallOf,
  type SpawnGroups,
  type SubagentNode,
  startedNode,
  stateNode,
  subtree as subtreeOf,
  trackGroup,
  treeRows,
  updateNode,
} from "./subagents.ts"
import { ToolCalls, type TrackedCall } from "./tool-calls.ts"
import {
  explorationOf,
  exploredLines,
  type FinishedCall,
  finishedToolLines,
  heldToolLine,
  OUTPUT_LINES,
  runningToolLines,
} from "./tool-view.ts"
import {
  type BlockKind,
  commandOutputLines,
  type NoticeLevel,
  noticeLines,
  Transcript,
} from "./transcript.ts"
import { type TranscriptView, View, type ViewHost } from "./view.ts"

/** The renderer's shortest time between frames. */
const FRAME_MS = 16

/**
 * The inline view: finished messages and tool calls are committed to the terminal's
 * scrollback; the live region holds the streaming reply, running tool calls, sub-agents that
 * outlive their committed call, and the bottom area below them.
 */
export function createInlineView(host: ViewHost): TranscriptView {
  const { terminal, theme, presenters } = host
  // The reply is Markdown: its finished blocks go to the scrollback as they close; images and
  // what extensions render (D88) as they are ready.
  const nodes = inlineNodes({ renders: host.renders, images: () => host.images?.(), theme })
  const streaming = new MarkdownStream({
    hyperlinks: host.hyperlinks,
    nodes,
  })
  const transcript = new Transcript()
  const toolCalls = new ToolCalls()
  /** Tool names by call id, for the head of sub-agents that outlive their committed call. */
  const callNames = new Map<string, string>()
  /**
   * This session's sub-agents (and theirs), in start order, from their start until their line
   * is committed: one that ends while its call is live stays, as its end line, until the call
   * is committed with it; one whose call was committed already goes when it ends.
   */
  const subagents = new Map<string, SubagentNode>()
  /** Spawn groups of this session's tree, as their latest event had them. */
  const spawnGroups: SpawnGroups = new Map()
  /** Redraws once a second while sub-agents run, so their elapsed time moves. */
  let subagentTimer: ReturnType<typeof setInterval> | undefined
  const tickSubagents = () => {
    const running = [...subagents.values()].some(isActive)
    if (running && !subagentTimer) subagentTimer = setInterval(() => renderer.requestRender(), 1000)
    else if (!running && subagentTimer) {
      clearInterval(subagentTimer)
      subagentTimer = undefined
    }
  }

  /**
   * Lines to print above the live region, sent with the next frame: running a command commits
   * its echo and then each thing it prints, and a redraw for each of those flickered.
   */
  const pendingCommits: string[] = []
  const commit = (lines: string[]) => {
    pendingCommits.push(...lines)
    renderer.requestRender()
  }
  /**
   * Commits a whole block, spaced by the transcript's rule. Exploring calls held to go as one
   * row go first: what comes after them ends their run.
   */
  const commitBlock = (kind: BlockKind, lines: string[]) => {
    flushExplored()
    commit(transcript.block(kind, lines))
  }
  /** A system notice fitted to the terminal. */
  const note = (level: NoticeLevel, text: string) => noticeLines(theme, level, text, terminal.columns)
  /** How finished calls show besides the detail level: the user's settings. */
  const toolOptions = () => ({ outputLines: host.settings.shellOutputLines ?? OUTPUT_LINES })

  /**
   * Successful calls in a row that only looked around (read, grep, glob), held back from the
   * scrollback so that they go as one "Explored" row once something else comes.
   */
  let exploring: { call: FinishedCall; presenter: ToolPresenter | undefined }[] = []
  /** The held exploring calls as they will be committed: one call as itself, more as one row. */
  const exploredRows = (width: number, t: Theme, detail: ToolDetailLevel) => {
    if (exploring.length === 1) {
      const [{ call, presenter }] = exploring as [(typeof exploring)[number]]
      return finishedToolLines(t, presenter, call, detail, width, toolOptions())
    }
    return exploredLines(t, exploring, detail === "full", detail, width, toolOptions())
  }
  function flushExplored(): void {
    if (!exploring.length) return
    const lines = exploredRows(terminal.columns, theme, host.detail())
    exploring = []
    commit(transcript.block("tool", lines))
  }

  /** The reasoning of the reply streaming now: its text and when it started. */
  let thought: { text: string; startedAt: number } | undefined
  /** Commits the reasoning, once the reply goes on: "∴ Thought for 12s", its text at "full". */
  function commitThought(): boolean {
    if (!thought) return false
    const { text, startedAt } = thought
    thought = undefined
    const expanded = host.detail() === "full"
    const lines = reasoningLines(
      theme,
      text,
      { durationMs: Date.now() - startedAt, expanded },
      terminal.columns,
    )
    commitBlock("reasoning", lines)
    return true
  }

  const childrenOfCall = (parent: string, callId?: string) => childrenOf(subagents, parent, callId)
  const subtree = (n: SubagentNode) => subtreeOf(subagents, n)
  /** The sub-agents a call of this session started, and theirs, depth first. */
  const callTree = (callId: string) => childrenOfCall(host.sessionId(), callId).flatMap(subtree)
  const rootCall = (n: SubagentNode) => rootCallOf(subagents, host.sessionId(), n)
  const isLiveCall = (id: string | undefined) => id !== undefined && toolCalls.live.some((c) => c.id === id)

  /**
   * The tool calls of the step, in call order: running ones with their output, held ones done.
   * At most `max` rows: past that, running calls drop their output lines, and then the first
   * calls give way to a line counting them, so the latest stay in view.
   */
  function liveToolRows(width: number, ctx: RenderContext, max = Number.POSITIVE_INFINITY): string[] {
    const live = toolCalls.live
    if (!live.length && !exploring.length) return []
    const gap = transcript.gapBefore("tool") ? [""] : []
    const now = Date.now()
    const draw = (output: boolean) => {
      const calls: string[][] = []
      // The exploring calls held back, as the row they become.
      if (exploring.length) calls.push(exploredRows(width, ctx.theme, "collapsed").slice(0, 1))
      for (const c of live) {
        const presenter = presenters?.get(c.name)
        const head = c.end
          ? [heldToolLine(ctx.theme, presenter, finished(c), width)]
          : runningToolLines(ctx.theme, presenter, c, now, host.spinner.glyph, width)
        calls.push([
          ...(output ? head : head.slice(0, 1)),
          ...treeRows(callTree(c.id), now, width, ctx.theme, spawnGroups),
        ])
      }
      return calls
    }
    let calls = draw(true)
    const count = (list: string[][]) => gap.length + list.reduce((n, c) => n + c.length, 0)
    if (count(calls) > max) calls = draw(false)
    let hidden = 0
    while (count(calls) + (hidden ? 1 : 0) > max && calls.length > 1) {
      calls = calls.slice(1)
      hidden++
    }
    const more = hidden ? [ctx.theme.muted(`  ${glyphs.more} ${plural(hidden, "earlier call")}`)] : []
    return [...gap, ...more, ...calls.flat()]
  }

  /** Sub-agents running on after their call was committed, under a small header. */
  function backgroundRows(width: number, t: Theme): string[] {
    const live = new Set(toolCalls.live.map((c) => c.id))
    const underCall = (n: SubagentNode) =>
      n.parent === host.sessionId() && n.toolCallId !== undefined && live.has(n.toolCallId)
    const roots = [...subagents.values()].filter((n) => !subagents.has(n.parent) && !underCall(n))
    if (!roots.length) return []
    const now = Date.now()
    // Grouped by the agent call that started them, under a head shaped like that call's, so the
    // group reads as the call going on down here (a committed call cannot be updated in place).
    const groups = new Map<string | undefined, SubagentNode[]>()
    for (const n of roots) groups.set(n.toolCallId, [...(groups.get(n.toolCallId) ?? []), n])
    const sep = ` ${t.muted(glyphs.separator)} `
    const rows: string[] = []
    for (const [callId, group] of groups) {
      const started = Math.min(...group.map((n) => n.startedAt ?? now))
      const count = plural(group.length, "sub-agent")
      const head =
        callId === undefined
          ? `${t.accent(glyphs.subagent)} ${t.muted(backgroundLabel(spawnGroups, group))}`
          : `${t.success(glyphs.toolRunning)} ${t.accent(callNames.get(callId) ?? "agent")}${sep}${count}${sep}${t.muted(`running in background${sep}${formatElapsed(now - started)}`)}`
      rows.push(truncateToWidth(head, width, glyphs.more))
      rows.push(...treeRows(group.flatMap(subtree), now, width, t, spawnGroups))
    }
    return [...rows, ""]
  }

  // Sub-agents whose call is committed already (it returned at once): they run on here.
  const background = new View((width, ctx) => backgroundRows(width, ctx.theme))

  // The reply streams above the rest and gets the rows it leaves, less one that keeps the line
  // before it in view. Its finished blocks, and rows past that, go to the scrollback as they
  // are finished (MarkdownStream), indented like the committed reply and spaced by the
  // transcript's rule. A dialog gets what the rest leaves, so its title is never cut off the top.
  const gutter = glyphs.assistant
  const root = new View((width, ctx) => {
    // Lines committed since the last frame go out with this one: one redraw, not one each.
    if (pendingCommits.length) ctx.commit?.(pendingCommits.splice(0))
    // Live tool rows sit above the dialog (often the call that asked it), with the blank row
    // before the rest; the dialog fits in what they leave. No reply streams while tools are live.
    // Many calls at once take at most half the screen, so the input stays where it is.
    const tools = liveToolRows(width, ctx, Math.max(4, Math.floor(ctx.rows / 2)))
    const budget = ctx.rows - 1 - (tools.length ? tools.length + 1 : 0)
    const rest = host.bottom(width, ctx, budget, background)
    streaming.maxRows = Math.max(1, ctx.rows - rest.length - tools.length - 3)
    const commit = ctx.commit
    const replyCtx: RenderContext = commit
      ? {
          ...ctx,
          commit: (rows) => commit(transcript.continue("assistant", replyRows(rows))),
        }
      : ctx
    const reply = streaming.render(Math.max(1, width - visibleWidth(gutter)), replyCtx)
    const lead = reply.length && transcript.gapBefore("assistant") ? [""] : []
    return [...lead, ...replyRows(reply), ...tools, "", ...rest]
  })
  const reflow = host.settings.reflow ?? "auto"
  const renderer = new LiveRenderer(terminal, root, {
    synchronizedOutput: host.capabilities.synchronizedOutput,
    frameIntervalMs: FRAME_MS,
    theme,
    // "auto" assumes a re-wrapping terminal, as Windows Terminal, VS Code and most others are.
    reflow: reflow !== "off",
  })

  /**
   * Forms and the sub-agent viewer go on the alternate screen. The inline UI is suspended
   * meanwhile: what the main session commits is held and printed when it closes.
   */
  const fullScreen = new FullScreenRenderer(terminal, host.overlay, {
    synchronizedOutput: host.capabilities.synchronizedOutput,
    theme,
    frameIntervalMs: 33,
  })

  function finished(c: TrackedCall) {
    return {
      name: c.name,
      args: c.args,
      result: c.end!.result,
      durationMs: c.end!.durationMs,
      ...(c.end!.rejected ? { rejected: c.end!.rejected } : {}),
      interrupted: c.end!.interrupted ?? false,
    }
  }

  /**
   * Commits finished calls, each with the end lines of the sub-agents it started right under
   * its head. Sub-agents still running go on in the background rows. True when it committed any.
   */
  function commitCalls(calls: TrackedCall[]): boolean {
    for (const c of calls) {
      const tree = callTree(c.id)
      const ends: string[] = []
      const cutShort = c.end!.interrupted || c.end!.rejected !== undefined
      // The call's own result line comes after them, so only a nested one can close a level.
      const layout = treeLayout(tree, false)
      for (const [i, n] of tree.entries()) {
        if (n.end && compactGroup(spawnGroups, n)) {
          // A compact group's line tells how it goes; its members get no lines of their own.
          subagents.delete(n.id)
        } else if (n.end) {
          const { last, indent } = layout[i]!
          ends.push(subagentEndLine(n, n.end, terminal.columns, theme, last, indent))
          subagents.delete(n.id)
        } else n.detached = cutShort ? "interrupted" : "background"
      }
      const presenter = presenters?.get(c.name)
      const call = finished(c)
      // A call that only looked around waits for the next one: a run of them is one row.
      if (!tree.length && explorationOf(presenter, call)) {
        exploring.push({ call, presenter })
        continue
      }
      const lines = finishedToolLines(theme, presenter, call, host.detail(), terminal.columns, toolOptions())
      lines.splice(1, 0, ...ends)
      commitBlock("tool", lines)
    }
    return calls.length > 0
  }

  /**
   * Once calls were dropped without being committed (a turn ended or the session changed):
   * ended sub-agents they held are committed on their own, running ones are cut loose.
   */
  function settleSubagents() {
    for (const n of subagents.values()) {
      if (isLiveCall(rootCall(n))) continue
      if (n.end) {
        if (endsAlone(n)) commitBlock("tool", [subagentEndLine(n, n.end, terminal.columns, theme)])
        subagents.delete(n.id)
      } else n.detached ??= "interrupted"
    }
  }

  /**
   * Whether a sub-agent that ended away from its call gets its end line on its own: only one
   * the tree stopped. One that finished its task after its call was cut short kept running in
   * the background (the main session's agent calls survive an interrupt), and its notice
   * reports it; a line here would say it twice.
   */
  function endsAlone(n: SubagentNode): boolean {
    return n.detached !== "background" && n.end?.status === "aborted" && !compactGroup(spawnGroups, n)
  }

  /** Keeps the sub-agent rows current; true when the event was about a sub-agent. */
  function trackSubagent(e: AnyEvent): boolean {
    const mine = e.sessionId === host.sessionId() || subagents.has(e.sessionId)
    switch (e.type) {
      case "subagent.start": {
        if (!mine) return false
        const node = startedNode(e)
        subagents.set(node.id, node)
        // Started under a tree whose call is committed already: it runs in the background.
        const parent = subagents.get(node.parent)
        if (parent?.detached) node.detached = parent.detached
        break
      }
      case "subagent.end": {
        const node = subagents.get(e.data.childSessionId)
        if (!node) return false
        endNode(node, e)
        // Under a live call its rows become its end line, committed with the call. Otherwise it
        // is done: a background one's notice reports it; one cut short gets its line on its own.
        if (isLiveCall(rootCall(node))) break
        subagents.delete(node.id)
        if (endsAlone(node)) commitBlock("tool", [subagentEndLine(node, node.end!, terminal.columns, theme)])
        break
      }
      case "subagent.state": {
        const node = subagents.get(e.data.childSessionId)
        if (!node) return false
        stateNode(node, e)
        break
      }
      case "group.start":
      case "group.update":
      case "group.end":
        // Only a compact group's own line shows it.
        if (!mine || !trackGroup(spawnGroups, e)) return false
        break
      case "budget.exceeded":
        commitBlock(
          "notice",
          note("warning", `Budget spent (${e.data.tokens} tokens); sub-agents were stopped.`),
        )
        return true
      default: {
        const sub = subagents.get(e.sessionId)
        if (!sub) return false
        updateNode(sub, e, presenters)
        return true
      }
    }
    tickSubagents()
    return true
  }

  return {
    get runningTools() {
      return toolCalls.running
    },
    capturing: false,
    start: () => renderer.start(),
    requestRender: () => renderer.requestRender(),
    render: () => renderer.render(),
    redraw: () => renderer.redraw(),
    openOverlay() {
      renderer.suspend()
      fullScreen.open()
    },
    closeOverlay() {
      fullScreen.close()
      renderer.resume()
    },
    requestOverlayRender: () => fullScreen.requestRender(),
    redrawOverlay: () => fullScreen.redraw(),
    renderOverlay: () => fullScreen.render(),
    stop() {
      subagents.clear()
      spawnGroups.clear()
      tickSubagents()
      flushExplored()
      // What was committed but not drawn yet still belongs in the scrollback.
      if (pendingCommits.length) renderer.render()
      renderer.stop({ clear: true })
    },

    banner: (line) => commitBlock("banner", [line]),
    user: (m) => commitBlock("user", userLines(theme, m, terminal.columns)),
    replyDelta(text) {
      // The reply goes on: what it thought, and the calls held before it, go first.
      commitThought()
      flushExplored()
      streaming.append(text)
    },
    reasoningDelta(text) {
      thought ??= { text: "", startedAt: Date.now() }
      thought.text += text
    },
    replyEnd(calls) {
      // The rows still live are committed as they are shown; earlier ones already were.
      const early = streaming.committedRows > 0
      const rows = streaming.take(Math.max(1, terminal.columns - visibleWidth(gutter)))
      if (rows.length) commit(transcript.continue("assistant", replyRows(rows)))
      transcript.end()
      // Thinking that came after the text (or with none) goes after it.
      const thoughtShown = commitThought()
      toolCalls.expect(calls.map((c) => c.id))
      return rows.length > 0 || early || thoughtShown
    },
    toolStart(id, name, args, at) {
      toolCalls.start(id, name, args, at)
      callNames.set(id, name)
    },
    toolUpdate: (id, partial) => toolCalls.update(id, partial),
    toolEnd: (id, end) => commitCalls(toolCalls.end(id, end)),
    turnEnd() {
      const shown = commitCalls(toolCalls.flush())
      // A run of exploring calls ends with the turn.
      flushExplored()
      // Sub-agents of calls that never ended.
      settleSubagents()
      // Only calls with sub-agents still around need their names.
      for (const id of callNames.keys())
        if (![...subagents.values()].some((n) => n.toolCallId === id)) callNames.delete(id)
      tickSubagents()
      return shown
    },
    subagentEvent: trackSubagent,
    notice: (level, text) => commitBlock("notice", note(level, text)),
    commandEcho: (line) => commitBlock("command", commandEchoLines(theme, line, terminal.columns)),
    commandOutput(level, text) {
      // Right after its command it hangs under the echo; on its own it is a notice.
      if (transcript.last === "command" || transcript.last === "command-output") {
        commitBlock("command-output", commandOutputLines(theme, level, text, terminal.columns))
      } else commitBlock("notice", note(level, text))
    },
    dialogEcho: (draw) => commitBlock("dialog", draw(Math.max(1, terminal.columns))),
    history(messages: Message[], session) {
      flushExplored()
      commit(
        historyLines(theme, messages, {
          ...(presenters ? { presenters } : {}),
          width: terminal.columns,
          detail: host.detail(),
          session,
          transcript,
          hyperlinks: host.hyperlinks,
          nodes,
          ...toolOptions(),
        }),
      )
    },
    leaveSession() {
      toolCalls.flush()
      thought = undefined
      flushExplored()
      settleSubagents()
      callNames.clear()
      // The old session's sub-agents and groups are not shown under the new one.
      subagents.clear()
      spawnGroups.clear()
      tickSubagents()
    },
    detailNote(level: ToolDetailLevel) {
      const cycle = host.keys.label("tool-output")
      return `Tool output: ${level} (applies to tool results from now on${cycle ? `; ${cycle} cycles` : ""})`
    },
    handleInput: () => false,
  }
}
