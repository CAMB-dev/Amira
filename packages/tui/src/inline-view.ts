import {
  type AnyEvent,
  DEFAULT_TUI_REFLOW,
  type Message,
  plural,
  type ToolDetailLevel,
  type ToolPresenter,
} from "@amira/api"
import {
  FullScreenRenderer,
  LiveRenderer,
  modes,
  type RenderContext,
  Spinner,
  type Theme,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { discardLive, pauseFullScreen, prependLiveBoundary } from "../../tui-kit/src/renderer-controls.ts"
import {
  commandEchoLines,
  messageTimestamp,
  reasoningLines,
  replyRows,
  spawnGroupRow,
  subagentEndLine,
  timestampRoom,
  timestampRow,
  treeLayout,
  userLines,
} from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { CONTENT_INSET, contentRoom } from "./grid.ts"
import { historyLines } from "./history.ts"
import { inlineBackgroundRows, inlineDisplayNodes } from "./inline-background.ts"
import { displayCommit } from "./inline-display.ts"
import { inlineInput } from "./inline-input.ts"
import { inlineLiveLayout } from "./inline-live-layout.ts"
import { InlineTablePlacement } from "./inline-table-placement.ts"
import { contentGeometry, marginView } from "./margins.ts"
import { inlineNodes } from "./markdown-nodes.ts"
import {
  childrenOf,
  compactGroup,
  endNode,
  isWorking,
  resetGroups,
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
  runningOutputLimit,
  runningToolLines,
  treeContinuation,
} from "./tool-view.ts"
import {
  type BlockKind,
  commandOutputLines,
  type NoticeLevel,
  noticeDetailLines,
  noticeLines,
  Transcript,
} from "./transcript.ts"
import {
  activationBoundary,
  type CallRef,
  PendingCommits,
  type TranscriptView,
  View,
  type ViewHost,
} from "./view.ts"

/** The renderer's shortest time between frames. */
const FRAME_MS = 16

/**
 * The inline view: finished messages and tool calls are committed to the terminal's
 * scrollback; the live region holds the streaming reply, running tool calls, sub-agents that
 * outlive their committed call, and the bottom area below them.
 */
export function createInlineView(host: ViewHost): TranscriptView {
  const { terminal, presenters } = host
  let theme = host.theme
  const contentWidth = () => contentGeometry(terminal.columns, terminal.rows, host.settings, false).width
  // The reply is Markdown: its finished blocks go to the scrollback as they close; images and
  // what extensions render (D88) as they are ready.
  const nodes = inlineNodes({
    renders: host.renders,
    images: () => host.images?.(),
    get theme() {
      return theme
    },
  })
  const markerRows = new Set<string>()
  const tablePlacement = new InlineTablePlacement(
    () => contentGeometry(terminal.columns, terminal.rows, host.settings, false).left,
  )
  const streaming = tablePlacement.stream({
    hyperlinks: host.hyperlinks,
    nodes,
    headingMarkers: false,
    markerOutset: 2,
    onMarkerRow: (row) => markerRows.add(row),
  })
  const transcript = new Transcript()
  const toolCalls = new ToolCalls()
  const unstartedCalls = new Map<string, CallRef>()
  let stepIds: string[] = []
  const isLastTool = (id: string) => stepIds.at(-1) === id
  /** The first visible assistant row owns the turn's clock, even when it is not text. */
  let assistantSeen = false
  const firstAssistantTime = () => {
    if (assistantSeen) return undefined
    assistantSeen = true
    return Date.now()
  }
  const toolTimes = new Map<string, number>()
  /** A reply's clock is fixed at its first nonempty delta, and committed with its first row. */
  let replyAt: number | undefined
  let replySeen = false
  let pendingReplyWhitespace = ""
  let replyStamped = false
  const replyWidth = (width: number) => {
    streaming.firstRowWidth = Math.max(
      1,
      timestampRoom(width, replyStamped ? undefined : replyAt) - visibleWidth(glyphs.assistant),
    )
    return Math.max(1, width - visibleWidth(glyphs.assistant))
  }
  const drawReply = (rows: string[], width: number, t: Theme, committing = false) => {
    const lines = replyRows(rows, markerRows)
    if (lines.length && !replyStamped) {
      lines[0] = timestampRow(lines[0]!, t, width, replyAt)
      if (committing) replyStamped = true
    }
    return tablePlacement.attach(lines, rows, committing)
  }
  const continuedReply = (rows: string[], width: number, t: Theme) => {
    const lines = drawReply(rows, width, t, true)
    return tablePlacement.prepend(transcript.continue("assistant", lines), lines)
  }
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
  /** Compact groups keep their placement after the last member leaves, but never keep a timer alive. */
  const groupAnchors = new Map<string, { node: SubagentNode; callId?: string }>()
  const committedGroups = new Set<string>()
  const displayNodes = () => inlineDisplayNodes(subagents, groupAnchors, committedGroups)
  /** Working children keep the shared spinner alive even after the parent's turn ends. */
  let subagentTimer: ReturnType<typeof setInterval> | undefined
  const tickSubagents = () => {
    const running = !renderer.isSuspended && [...subagents.values()].some(isWorking)
    if (running && !subagentTimer)
      subagentTimer = setInterval(() => {
        if (!host.spinner.running) host.spinner.tick()
        renderer.requestRender()
      }, Spinner.INTERVAL_MS)
    else if (!running && subagentTimer) {
      clearInterval(subagentTimer)
      subagentTimer = undefined
    }
  }

  const pendingCommits = new PendingCommits(() => renderer.requestRender())
  /** An answered picker stays live until output follows; a session boundary replaces it. */
  let pendingDialog: ((width: number) => string[]) | undefined
  function flushDialog(): void {
    if (!pendingDialog) return
    const draw = pendingDialog
    pendingDialog = undefined
    commit(transcript.block("dialog", draw(Math.max(1, contentWidth()))))
  }
  const commit = pendingCommits.commit
  /**
   * Commits a whole block, spaced by the transcript's rule. Exploring calls held to go as one
   * row go first: what comes after them ends their run.
   */
  const commitBlock = (kind: BlockKind, lines: string[]) => {
    flushDialog()
    flushExplored()
    commit(transcript.block(kind, lines))
  }
  /** A system notice fitted to the terminal. */
  const note = (level: NoticeLevel, text: string) => noticeLines(theme, level, text, contentWidth())
  /** How finished calls show besides the detail level: the user's settings. */
  const toolOptions = (last = false, timestamp?: number) => ({
    outputLines: host.settings.shellOutputLines ?? OUTPUT_LINES,
    last,
    timestamp,
  })

  /**
   * Successful calls in a row that only looked around (read, grep, glob), held back from the
   * scrollback so that they go as one "Explored" row once something else comes.
   */
  let exploring: {
    call: FinishedCall
    presenter: ToolPresenter | undefined
    last: boolean
    timestamp?: number
  }[] = []
  /** The held exploring calls as they will be committed: one call as itself, more as one row. */
  const exploredRows = (width: number, t: Theme, detail: ToolDetailLevel) => {
    const opts = toolOptions(
      exploring.at(-1)?.last,
      exploring.find((entry) => entry.timestamp !== undefined)?.timestamp,
    )
    if (exploring.length === 1) {
      const [{ call, presenter }] = exploring as [(typeof exploring)[number]]
      return finishedToolLines(t, presenter, call, detail, width, opts)
    }
    return exploredLines(t, exploring, detail === "full", detail, width, opts)
  }
  function flushExplored(): void {
    if (!exploring.length) return
    const lines = exploredRows(contentWidth(), theme, host.detail())
    exploring = []
    commit(transcript.block("tool", lines))
  }

  /** The reasoning of the reply streaming now: its text and when it started. */
  let thought: { text: string; startedAt: number; timestamp?: number } | undefined
  /** Commits the reasoning, once the reply goes on: "∴ Thought for 12s", its text at "full". */
  function commitThought(): boolean {
    if (!thought) return false
    const { text, startedAt, timestamp } = thought
    thought = undefined
    const expanded = host.detail() === "full"
    const lines = reasoningLines(
      theme,
      text,
      { durationMs: Date.now() - startedAt, expanded, timestamp },
      contentWidth(),
    )
    commitBlock("reasoning", lines)
    return true
  }

  /** The sub-agents a call of this session started, and theirs, depth first. */
  const callTree = (callId: string) => {
    const nodes = displayNodes()
    return childrenOf(nodes, host.sessionId(), callId).flatMap((n) => subtreeOf(nodes, n))
  }
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
    const runningAt = live.findIndex((c) => !c.end)
    const separated =
      runningAt >= 0 &&
      (exploring.length > 0 ||
        runningAt > 0 ||
        ["tool", "assistant", "reasoning"].includes(transcript.last ?? ""))
    const gap =
      separated && !exploring.length && runningAt === 0 ? [] : transcript.gapBefore("tool") ? [""] : []
    const now = Date.now()
    const streamingCalls = live.filter((call) => !call.end && call.partial)
    const draw = (output: boolean) => {
      const calls: string[][] = []
      // The exploring calls held back, as the row they become.
      if (exploring.length && host.detail() === "full") {
        for (const [i, { call, presenter, timestamp }] of exploring.entries()) {
          const last = i === exploring.length - 1 && exploring.at(-1)?.last
          const rows = finishedToolLines(
            ctx.theme,
            presenter,
            call,
            "full",
            width,
            toolOptions(last, timestamp),
          )
          calls.push(output ? rows : rows.slice(0, 1))
        }
      } else if (exploring.length) calls.push(exploredRows(width, ctx.theme, "collapsed").slice(0, 1))
      for (const [i, c] of live.entries()) {
        const boundary =
          separated && i === runningAt ? ["", ctx.theme.muted(`  ${glyphs.rule.repeat(3)}`), ""] : []
        const presenter = presenters?.get(c.name)
        const opts = toolOptions(isLastTool(c.id), toolTimes.get(c.id))
        const head = c.end
          ? [heldToolLine(ctx.theme, presenter, finished(c), width, opts)]
          : runningToolLines(ctx.theme, presenter, c, now, host.spinner.glyph, width, {
              ...opts,
              liveOutputLines: runningOutputLimit(streamingCalls.indexOf(c), streamingCalls.length),
            })
        calls.push([
          ...boundary,
          ...(output ? head : head.slice(0, 1)),
          ...treeRows(
            callTree(c.id),
            now,
            Math.max(1, width - visibleWidth(treeContinuation(ctx.theme, isLastTool(c.id)))),
            ctx.theme,
            spawnGroups,
            true,
            host.spinner.glyph,
          ).map((row) => treeContinuation(ctx.theme, isLastTool(c.id)) + row),
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

  // Sub-agents whose call is committed already render from the durable display placement.
  const background = new View((width, ctx) =>
    inlineBackgroundRows(width, ctx.theme, {
      sessionId: host.sessionId(),
      liveCalls: toolCalls.live,
      nodes: displayNodes(),
      groups: spawnGroups,
      callNames,
      spinner: host.spinner.glyph,
      now: Date.now(),
    }),
  )

  // The reply streams above the rest and gets the rows it leaves, less one that keeps the line
  // before it in view. Its finished blocks, and rows past that, go to the scrollback as they
  // are finished (MarkdownStream), indented like the committed reply and spaced by the
  // transcript's rule. A dialog gets what the rest leaves, so its title is never cut off the top.
  const root = new View((width, ctx) => {
    pendingCommits.flush(width, ctx)
    // Live tools sit above the bottom area, but cannot displace an interactive dialog's
    // title, selected option and footer. No reply streams while tools are live.
    const { dialog, tools, budget } = inlineLiveLayout({
      rows: ctx.rows,
      width,
      dialog: pendingDialog,
      dialogGap: transcript.gapBefore("dialog"),
      essentialBottomRows: host.essentialBottomRows?.() ?? 0,
      tools: (max) => liveToolRows(width, ctx, max),
    })
    const rest = host.bottom(width, ctx, budget, background)
    const thinking = thought
      ? [
          ...(transcript.gapBefore("reasoning") ? [""] : []),
          ...reasoningLines(
            ctx.theme,
            thought.text,
            {
              thinking: true,
              timestamp: thought.timestamp,
              expanded: host.detail() === "full",
              expandKey: host.detail() === "summary" ? host.keys.label("tool-output") : undefined,
            },
            width,
          ),
        ]
      : []
    // Thinking can be long at full detail, but must not push the input out of the live region.
    const thoughtBudget = Math.max(1, ctx.rows - rest.length - tools.length - dialog.length - 2)
    if (thinking.length > thoughtBudget && thinking[0] === "") thinking.shift()
    if (thinking.length > thoughtBudget) {
      thinking.length = thoughtBudget
      if (thoughtBudget > 1) thinking[thoughtBudget - 1] = ctx.theme.muted(`  ${glyphs.more}`)
    }
    tablePlacement.beginFrame()
    streaming.maxRows = Math.max(
      1,
      ctx.rows - rest.length - tools.length - dialog.length - thinking.length - 3,
    )
    const commit = ctx.commit
    const replyCtx: RenderContext = commit
      ? {
          ...ctx,
          commit: (rows) => commit(continuedReply(rows, width, ctx.theme)),
        }
      : ctx
    const reply = streaming.render(replyWidth(width), replyCtx)
    const lead = reply.length && transcript.gapBefore("assistant") ? [""] : []
    const replyLines = drawReply(reply, width, ctx.theme)
    const rows = [...dialog, ...thinking, ...lead, ...replyLines, ...tools, "", ...rest]
    return tablePlacement.prepend(rows, replyLines, dialog.length + thinking.length + lead.length)
  })
  const reflow = host.settings.reflow ?? DEFAULT_TUI_REFLOW
  const margined = marginView(root, host.settings, false, (lines) => tablePlacement.insets(lines))
  const renderer = new LiveRenderer(terminal, margined, {
    synchronizedOutput: host.capabilities.synchronizedOutput,
    frameIntervalMs: FRAME_MS,
    theme,
    glyphs: host.glyphs,
    // "auto" assumes a re-wrapping terminal, as Windows Terminal, VS Code and most others are.
    reflow: reflow !== "off",
  })
  let offDockResize: (() => void) | undefined

  /**
   * Forms and the sub-agent viewer go on the alternate screen. The inline UI is suspended
   * meanwhile: what the main session commits is held and printed when it closes.
   */
  const fullScreen = new FullScreenRenderer(terminal, marginView(host.overlay, host.settings, true), {
    synchronizedOutput: host.capabilities.synchronizedOutput,
    theme,
    glyphs: host.glyphs,
    frameIntervalMs: 33,
  })

  function finished(c: TrackedCall) {
    return {
      name: c.name,
      args: c.args,
      result: c.end!.result,
      durationMs: c.end!.durationMs,
      ...(c.end!.rejected ? { rejected: c.end!.rejected } : {}),
      ...(c.end!.approval ? { approval: c.end!.approval } : {}),
      interrupted: c.end!.interrupted ?? false,
    }
  }

  /**
   * Commits finished calls, each with the end lines of the sub-agents it started right under
   * its head. Sub-agents still running go on in the background rows. True when it committed any.
   */
  function commitCalls(calls: TrackedCall[]): boolean {
    for (const c of calls) {
      const folded = new Set<string>()
      const tree = callTree(c.id).filter((n) => {
        const group = compactGroup(spawnGroups, n)
        if (!group) return true
        if (folded.has(group.id)) return false
        folded.add(group.id)
        return true
      })
      const continuation = treeContinuation(theme, isLastTool(c.id))
      const treeWidth = Math.max(1, contentWidth() - visibleWidth(continuation))
      const ends: string[] = []
      const cutShort = c.end!.interrupted || c.end!.rejected !== undefined
      // The call's own result line comes after them, so only a nested one can close a level.
      const layout = treeLayout(tree, false)
      for (const [i, n] of tree.entries()) {
        const group = compactGroup(spawnGroups, n)
        if (group) {
          if (group.state === "ended" && !committedGroups.has(group.id)) {
            const { last, indent } = layout[i]!
            ends.push(continuation + spawnGroupRow(group, n.depth, treeWidth, theme, last, indent))
            committedGroups.add(group.id)
          }
          // The durable group placement survives even when every ended member is removed.
          for (const member of subagents.values()) {
            if (member.groupId !== group.id) continue
            if (member.end) subagents.delete(member.id)
            else member.detached = cutShort ? "interrupted" : "background"
          }
        } else if (n.end) {
          const { last, indent } = layout[i]!
          ends.push(continuation + subagentEndLine(n, n.end, treeWidth, theme, last, indent))
          subagents.delete(n.id)
        } else n.detached = cutShort ? "interrupted" : "background"
      }
      const presenter = presenters?.get(c.name)
      const call = finished(c)
      const timestamp = toolTimes.get(c.id)
      toolTimes.delete(c.id)
      // A call that only looked around waits for the next one: a run of them is one row.
      if (!tree.length && explorationOf(presenter, call)) {
        exploring.push({ call, presenter, last: isLastTool(c.id), timestamp })
        continue
      }
      const lines = finishedToolLines(
        theme,
        presenter,
        call,
        host.detail(),
        contentWidth(),
        toolOptions(isLastTool(c.id), timestamp),
      )
      lines.splice(1, 0, ...ends)
      commitBlock("tool", lines)
    }
    settleGroups()
    tickSubagents()
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
        if (endsAlone(n)) commitBlock("tool", [subagentEndLine(n, n.end, contentWidth(), theme)])
        subagents.delete(n.id)
      } else n.detached ??= "interrupted"
    }
  }

  /** Terminal snapshots print once, either with their live call or on their own after it leaves. */
  function settleGroups(stopping = false): void {
    for (const group of spawnGroups.values()) {
      if (!group.compact || group.state !== "ended" || committedGroups.has(group.id)) continue
      const anchor = groupAnchors.get(group.id)
      if (!stopping && isLiveCall(anchor?.callId)) continue
      commitBlock("tool", [spawnGroupRow(group, anchor?.node.depth ?? 1, contentWidth(), theme)])
      committedGroups.add(group.id)
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
        const node = startedNode(e, spawnGroups)
        subagents.set(node.id, node)
        if (node.groupId && compactGroup(spawnGroups, node) && !groupAnchors.has(node.groupId))
          groupAnchors.set(node.groupId, { node: { ...node }, callId: rootCall(node) })
        // Started under a tree whose call is committed already: it runs in the background.
        const parent = subagents.get(node.parent)
        if (parent?.detached) node.detached = parent.detached
        break
      }
      case "subagent.end": {
        const node = subagents.get(e.data.childSessionId)
        if (!node) return false
        endNode(node, e, spawnGroups)
        // Under a live call its rows become its end line, committed with the call. Otherwise it
        // is done: a background one's notice reports it; one cut short gets its line on its own.
        if (isLiveCall(rootCall(node))) break
        subagents.delete(node.id)
        if (endsAlone(node)) commitBlock("tool", [subagentEndLine(node, node.end!, contentWidth(), theme)])
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
      case "group.end": {
        // A nested group's parent may have left before its final snapshot arrives.
        if ((!mine && !spawnGroups.has(e.data.group.id)) || !trackGroup(spawnGroups, e)) return false
        const group = e.data.group
        if (group.state !== "ended") break
        settleGroups()
        // The terminal snapshot owns the aggregate, not stale working member rows.
        for (const n of subagents.values()) if (n.groupId === group.id) subagents.delete(n.id)
        break
      }
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
        tickSubagents()
        return true
      }
    }
    tickSubagents()
    return true
  }

  let visible = true
  let stopped = false
  let overlayMouse = false
  let displayDetail = host.detail()
  let hasDisplays = false
  let historyDirty = false
  const redrawHistory = () => {
    if (renderer.isSuspended) historyDirty = true
    else renderer.redraw()
  }
  const display: TranscriptView["display"] = (level, text, options) => {
    flushDialog()
    flushExplored()
    hasDisplays = true
    pendingCommits.push({ redraw: displayCommit(host, transcript, level, text, options) })
    renderer.requestRender()
  }

  return {
    get runningTools() {
      return toolCalls.running
    },
    capturing: false,
    start() {
      stopped = false
      offDockResize ??= terminal.onResize(() => {
        if (host.dockOpen?.()) renderer.redraw()
      })
      if (visible) renderer.start()
    },
    activate(boundary) {
      prependLiveBoundary(renderer, activationBoundary(boundary, contentWidth(), theme))
    },
    setVisible(next) {
      if (visible === next || stopped) return
      visible = next
      if (!visible) renderer.suspend()
      pauseFullScreen(fullScreen, !visible)
      if (overlayMouse) {
        if (visible) terminal.enableMode(modes.mouse)
        else terminal.disableMode(modes.mouse)
      }
      if (visible && !fullScreen.isOpen) {
        renderer.resume(false)
        renderer.start()
      }
      tickSubagents()
    },
    requestRender() {
      if (fullScreen.isOpen) fullScreen.requestRender()
      const next = host.detail()
      if (hasDisplays && next !== displayDetail) {
        displayDetail = next
        redrawHistory()
      } else renderer.requestRender()
    },
    render: () => renderer.render(),
    setTheme(next, nextGlyphs) {
      theme = next
      host.theme = next
      host.glyphs = nextGlyphs
      renderer.context = { ...renderer.context, theme: next, glyphs: nextGlyphs }
      fullScreen.context = { ...fullScreen.context, theme: next, glyphs: nextGlyphs }
      if (fullScreen.isOpen) fullScreen.redraw()
      redrawHistory()
    },
    redraw: redrawHistory,
    openOverlay(pointer = false) {
      renderer.suspend()
      tickSubagents()
      fullScreen.open()
      if (visible && pointer && !overlayMouse) terminal.enableMode(modes.mouse)
      if (visible && !pointer && overlayMouse) terminal.disableMode(modes.mouse)
      overlayMouse = pointer
    },
    closeOverlay() {
      if (visible && overlayMouse) terminal.disableMode(modes.mouse)
      overlayMouse = false
      fullScreen.close()
      if (visible) renderer.resume(historyDirty || host.dockOpen?.())
      tickSubagents()
      historyDirty = false
    },
    dockInput: (event) =>
      event.type === "mouse"
        ? { ...event, y: event.y - renderer.screenTop + renderer.context.rows - renderer.liveRows }
        : event,
    requestOverlayRender: () => fullScreen.requestRender(),
    redrawOverlay: () => fullScreen.redraw(),
    renderOverlay: () => fullScreen.render(),
    stop() {
      if (stopped) return
      stopped = true
      offDockResize?.()
      offDockResize = undefined
      settleGroups(true)
      subagents.clear()
      resetGroups(spawnGroups)
      groupAnchors.clear()
      committedGroups.clear()
      tickSubagents()
      flushDialog()
      flushExplored()
      // What was committed but not drawn yet still belongs in the scrollback.
      fullScreen.close()
      if (visible && overlayMouse) terminal.disableMode(modes.mouse)
      if (visible && pendingCommits.length) renderer.render()
      if (visible) renderer.stop({ clear: true })
      else discardLive(renderer)
      // A blank line between the last of the conversation and the shell's prompt.
      if (visible) terminal.write("\r\n")
    },

    // A blank line between the command that started Amira and its first line (not between the
    // banner's own lines). Wrapped at words, as full screen does, not cut by the terminal.
    banner: (line) =>
      commit([
        ...(transcript.last === undefined ? [""] : []),
        ...transcript.block(
          "banner",
          wrapText(typeof line === "function" ? line(theme) : line, contentRoom(contentWidth())).map(
            (row) => CONTENT_INSET + row,
          ),
        ),
      ]),
    user: (m) => commitBlock("user", userLines(theme, m, contentWidth(), messageTimestamp(m) ?? Date.now())),
    replyDelta(text) {
      // Buffer the source prefix without showing a row or ending thinking.
      if (!text.trim() && (thought || !replySeen)) {
        pendingReplyWhitespace += text
        return
      }
      text = pendingReplyWhitespace + text
      pendingReplyWhitespace = ""
      replySeen = true
      flushDialog()
      // The reply goes on: what it thought, and the calls held before it, go first.
      commitThought()
      flushExplored()
      if (text.trim() && !assistantSeen) replyAt = firstAssistantTime()
      streaming.append(text)
    },
    reasoningDelta(text) {
      if (!text) return
      flushDialog()
      thought ??= { text: "", startedAt: Date.now(), timestamp: firstAssistantTime() }
      thought.text += text
      renderer.requestRender()
    },
    replyEnd(calls) {
      pendingReplyWhitespace = ""
      replySeen = false
      flushDialog()
      // The rows still live are committed as they are shown; earlier ones already were.
      const early = streaming.committedRows > 0
      tablePlacement.beginFrame()
      const rows = streaming.take(replyWidth(contentWidth()))
      if (rows.length) commit(continuedReply(rows, contentWidth(), theme))
      markerRows.clear()
      replyAt = undefined
      transcript.end()
      // Thinking that came after the text (or with none) goes after it.
      const thoughtShown = commitThought()
      stepIds = calls.map((c) => c.id)
      unstartedCalls.clear()
      for (const call of calls) unstartedCalls.set(call.id, call)
      toolCalls.expect(stepIds)
      return rows.length > 0 || early || thoughtShown
    },
    toolStart(id, name, args, at) {
      unstartedCalls.delete(id)
      flushDialog()
      if (!stepIds.includes(id)) stepIds.push(id)
      const timestamp = firstAssistantTime()
      if (timestamp !== undefined) toolTimes.set(id, timestamp)
      toolCalls.start(id, name, args, at)
      callNames.set(id, name)
    },
    toolUpdate: (id, partial) => toolCalls.update(id, partial),
    toolEnd(id, end) {
      const call = unstartedCalls.get(id)
      if (call) {
        // A rejected call can become visible without ever starting.
        unstartedCalls.delete(id)
        flushDialog()
        const timestamp = firstAssistantTime()
        if (timestamp !== undefined) toolTimes.set(id, timestamp)
        toolCalls.start(id, call.name, call.args, Date.now())
      }
      return commitCalls(toolCalls.end(id, end))
    },
    turnEnd() {
      pendingReplyWhitespace = ""
      replySeen = false
      const shown = commitCalls(toolCalls.flush())
      unstartedCalls.clear()
      // A run of exploring calls ends with the turn.
      flushExplored()
      assistantSeen = false
      replyAt = undefined
      replyStamped = false
      toolTimes.clear()
      // Sub-agents of calls that never ended.
      settleSubagents()
      settleGroups()
      // Only calls with sub-agents or uncommitted compact groups still around need their names.
      for (const id of callNames.keys())
        if (![...displayNodes().values()].some((n) => n.toolCallId === id)) callNames.delete(id)
      tickSubagents()
      return shown
    },
    subagentEvent: trackSubagent,
    notice: (level, text, detail) =>
      commitBlock("notice", [
        ...note(level, text),
        // Inline, details show only at the full tool output level: the notice is printed once.
        ...(detail && host.detail() === "full"
          ? noticeDetailLines(theme, level, detail, contentWidth())
          : []),
      ]),
    display,
    commandEcho: (line) => commitBlock("command", commandEchoLines(theme, line, contentWidth())),
    commandOutput(level, text) {
      flushDialog()
      // Right after its command it hangs under the echo; on its own it is a notice.
      if (transcript.last === "command" || transcript.last === "command-output") {
        commitBlock("command-output", commandOutputLines(theme, level, text, contentWidth()))
      } else commitBlock("notice", note(level, text))
    },
    dialogEcho(draw) {
      flushDialog()
      flushExplored()
      pendingDialog = draw
      renderer.requestRender()
    },
    openSession(boundary, messages: Message[], switched, compactionInfo, displays) {
      if (switched) {
        pendingReplyWhitespace = ""
        replySeen = false
      }
      // The scrollback keeps what was committed: the boundary says where this session starts.
      flushExplored()
      commit(
        historyLines(theme, messages, {
          ...(presenters ? { presenters } : {}),
          width: contentWidth(),
          detail: host.detail(),
          session: boundary,
          transcript,
          displays,
          onDisplay: (d, preceding) => {
            commit(preceding)
            display(d.level, d.text, d.options)
          },
          hyperlinks: host.hyperlinks,
          nodes,
          glyphs: host.glyphs,
          ...toolOptions(),
          ...(compactionInfo ? { compactionInfo } : {}),
        }),
      )
    },
    leaveSession() {
      pendingReplyWhitespace = ""
      replySeen = false
      pendingDialog = undefined
      toolCalls.flush()
      unstartedCalls.clear()
      thought = undefined
      assistantSeen = false
      replyAt = undefined
      replyStamped = false
      toolTimes.clear()
      flushExplored()
      settleSubagents()
      settleGroups()
      callNames.clear()
      // The old session's sub-agents and groups are not shown under the new one.
      subagents.clear()
      resetGroups(spawnGroups)
      groupAnchors.clear()
      committedGroups.clear()
      tickSubagents()
    },
    ...inlineInput(host),
  }
}
