import type { Message, ToolDetailLevel, ToolResult } from "@amira/api"
import {
  closeStyles,
  FullScreenRenderer,
  isColorEnabled,
  modes,
  ProcessTerminal,
  presentEmoji,
  stripAnsi,
  stripColors,
  truncateToWidth,
} from "@amira/tui-kit"
import {
  type Block,
  type BlockEnv,
  type BlockImages,
  type BlockRenders,
  DetailNoticeBlock,
  ExploredBlock,
  exploredRun,
  fixedLine,
  LinesBlock,
  ReasoningBlock,
  ReplyBlock,
  SubagentGroupBlock,
  ToolBlock,
  userBlock,
} from "./blocks.ts"
import { commandEchoLines, messageTimestamp } from "./format.ts"
import { createFindSelect } from "./fullscreen/find-select.ts"
import { historyBlocks } from "./fullscreen/history-blocks.ts"
import { createMouse } from "./fullscreen/mouse.ts"
import { runningBoundary } from "./fullscreen/running-boundary.ts"
import { createSubagentBlocks } from "./fullscreen/subagent-blocks.ts"
import { glyphs } from "./glyphs.ts"
import { sessionBoundary } from "./history.ts"
import { stickyPrompt, stickyPromptLine } from "./pane/sticky-prompt.ts"
import { OUTPUT_LINES } from "./tool-view.ts"
import { commandOutputLines, type NoticeLevel, noticeLines } from "./transcript.ts"
import { TranscriptPane } from "./transcript-pane.ts"
import { type TranscriptView, View, type ViewHost } from "./view.ts"

/** The renderer's shortest time between frames. */
const FRAME_MS = 16
/** Rows the transcript keeps when a dialog wants the screen. */
const MIN_TRANSCRIPT_ROWS = 3

/**
 * The full-screen view (D84): the conversation is kept as blocks on the alternate screen and
 * drawn into a scrollable viewport above the same bottom area the inline view has. Blocks
 * change in place (a call finishing, its sub-agents moving on, also in the background after
 * the turn), fold and unfold, and are drawn again at any width. The wheel, PgUp/PgDn and
 * Home/End scroll; Ctrl+F finds; Ctrl+↑ selects blocks to fold or copy (OSC 52); dragging the
 * mouse selects text (D86), copied when it is released. On exit the whole conversation is
 * printed to the normal screen, as the inline view would have left it.
 */
export function createFullscreenView(host: ViewHost): TranscriptView {
  const { terminal, keys } = host
  let theme = host.theme
  const pane = new TranscriptPane()
  const boundary = runningBoundary(pane)
  /** Tool calls by id, for their sub-agents; kept after their turn. */
  const callBlocks = new Map<string, ToolBlock>()
  const subagents = createSubagentBlocks({
    sessionId: () => host.sessionId(),
    callBlock: (id) => callBlocks.get(id),
    add,
    requestRender: () => renderer.requestRender(),
    notice,
    get presenters() {
      return host.presenters
    },
  })
  const { nodes, groups } = subagents
  /** Calls of the running step, in call order. */
  let stepCalls: ToolBlock[] = []
  let reply: ReplyBlock | undefined
  /** The first visible assistant row owns the turn's clock, even when it is not text. */
  let assistantSeen = false
  const firstAssistantTime = () => {
    if (assistantSeen) return undefined
    assistantSeen = true
    return Date.now()
  }
  /** The reasoning of the reply streaming now, while it thinks. */
  let reasoning: ReasoningBlock | undefined
  let overlay = false

  /** The thinking is over: its line says for how long. True when it was shown. */
  const endReasoning = (): boolean => {
    if (!reasoning) return false
    reasoning.finish()
    reasoning = undefined
    return true
  }
  /** Rows of the transcript in the last frame, for mouse clicks. */
  let paneRows = 0
  let paneTop = 0

  /**
   * Images of replies, drawn in the transcript where the terminal can (D83) while an image
   * provider is installed (D88): the same object from frame to frame.
   */
  let drawn: BlockImages | undefined
  const imagesNow = (): BlockImages | undefined => {
    const store = host.images?.()
    if (!store) return undefined
    if (drawn?.store !== store) drawn = { store, changed: () => renderer.requestRender() }
    return drawn
  }
  /** Nodes of replies extensions render (D88). */
  const renders: BlockRenders = { renders: host.renders, changed: () => renderer.requestRender() }

  const env = (width: number): BlockEnv => {
    const images = imagesNow()
    return {
      theme,
      glyphs: host.glyphs,
      width,
      now: Date.now(),
      spinner: host.spinner.glyph,
      detail: host.detail(),
      reasoningExpandKey: keys.label("tool-output"),
      presenters: host.presenters,
      hyperlinks: host.hyperlinks,
      nodes,
      groups,
      renders,
      outputLines: host.settings.shellOutputLines ?? OUTPUT_LINES,
      ...(images ? { images } : {}),
    }
  }

  const findSelect = createFindSelect({
    editorEmpty: () => host.editorEmpty(),
    env,
    keys,
    openSubagent: host.openSubagent ? (id) => host.openSubagent?.(id) : undefined,
    pane,
    render: () => renderer.render(),
    showNote: (text) => host.showNote(text),
    terminal,
    get theme() {
      return theme
    },
  })

  /** Makes the exploring calls in a row around `block` one "Explored" row. */
  function regroup(block: Block): void {
    const run = exploredRun(pane.blocks, block, env(terminal.columns))
    if (!run) return
    pane.insertAfter(run.replaces.at(-1)!, run.group)
    const selected = pane.selected
    for (const b of run.replaces) pane.remove(b)
    if (selected && run.replaces.includes(selected)) pane.selected = run.group
    markToolTrees()
  }

  const root = new View((width, ctx) => {
    // Covered by a full-screen overlay, the transcript's images are not placed: they are cleared.
    if (overlay) return host.overlay.render(width, ctx)
    const header = host.header?.(width, ctx) ?? []
    // Reserve the existing header gap even when no prompt is pinned: transcript math stays fixed.
    if (header.length) header.push("")
    paneTop = header.length
    const barRows = findSelect.finding || pane.selected ? 1 : 0
    const budget = Math.max(1, ctx.rows - MIN_TRANSCRIPT_ROWS - 1 - barRows - paneTop)
    const bottom = host.bottom(width, ctx, budget)
    paneRows = Math.max(1, ctx.rows - bottom.length - barRows - 1 - paneTop)
    const frameEnv = env(width)
    const rows = pane.render(frameEnv, paneRows)
    const pinned = stickyPrompt(pane.blocks, pane.layout)
    if (pinned && header.length) header[header.length - 1] = stickyPromptLine(pinned, frameEnv)
    // Rendering refreshes matches as text streams in; the bar uses this frame's counts.
    const bar = findSelect.finding
      ? [findSelect.findBar(width)]
      : pane.selected
        ? [findSelect.selectBar(width)]
        : []
    // Image coordinates are transcript-relative; the fixed header stays above them.
    for (const p of pane.placements) ctx.place?.({ ...p, row: p.row + paneTop })
    // The row under the transcript says how much is below.
    const n = pane.rowsBelow
    const rowsBelow = `${n} row${n === 1 ? "" : "s"} below`
    const below = pane.following
      ? ""
      : truncateToWidth(
          pane.unseen
            ? theme.accent(`  ↓ new output · ${rowsBelow}${endHint()}`)
            : theme.muted(`  ↓ ${rowsBelow}${endHint()}`),
          width,
          glyphs.more,
        )
    return [...header, ...rows, below, ...bar, ...bottom]
  })
  const renderer = new FullScreenRenderer(terminal, root, {
    synchronizedOutput: host.capabilities.synchronizedOutput,
    theme,
    glyphs: host.glyphs,
    frameIntervalMs: FRAME_MS,
  })

  const mouseHandlers = createMouse({
    pane,
    paneRows: () => paneRows,
    paneTop: () => paneTop,
    stickyPrompt: () => (paneTop ? stickyPrompt(pane.blocks, pane.layout) : undefined),
    requestRender: () => renderer.requestRender(),
    showNote: (text) => host.showNote(text),
    terminal,
  })

  const endHint = () => {
    const end = keys.label("scroll.bottom")
    return end ? ` · ${end} follows` : ""
  }

  function markToolTrees(): void {
    boundary.update(stepCalls)
    const visible = pane.blocks.filter((b) => !(b instanceof ToolBlock) || b.started)
    for (const [i, b] of visible.entries()) {
      if (b instanceof ToolBlock || b instanceof ExploredBlock || b instanceof SubagentGroupBlock)
        b.last = visible[i + 1]?.kind !== "tool"
    }
  }

  function add(block: Block): void {
    pane.add(block)
    markToolTrees()
    renderer.requestRender()
  }

  function noticeBlock(level: NoticeLevel, text: string): LinesBlock {
    return new LinesBlock("notice", (width, t) => noticeLines(t, level, text, width), text)
  }

  function notice(level: NoticeLevel, text: string, detail?: string): void {
    add(detail ? new DetailNoticeBlock(level, text, detail) : noticeBlock(level, text))
  }

  /** Ends the calls of the step that never finished: unstarted ones go, running ones read as cut short. */
  function settleStep(): void {
    boundary.clear()
    for (const b of stepCalls) {
      if (!b.started) pane.remove(b)
      else if (!b.end) {
        const result: ToolResult = { content: [], isError: true }
        b.end = { result, durationMs: Date.now() - (b.startedAt ?? Date.now()), rejected: "aborted" }
        b.touch()
      }
    }
    stepCalls = []
  }

  /**
   * The text of the rows as they stay on the normal screen: styles closed, colors as allowed,
   * and emoji asked for as they were measured, as the renderers write them. A blank line
   * sets it apart from the command that started Amira above it and the shell's prompt below.
   */
  function printout(): string {
    boundary.clear()
    const color = isColorEnabled()
    const lines = pane.printout(env(terminal.columns))
    const rows = lines.map((l) => `${presentEmoji(closeStyles(color ? l : stripColors(l)))}\r\n`).join("")
    return `\r\n${rows}\r\n`
  }

  /** The transcript starts afresh for another session: only the banner stays. */
  function clearTranscript(): void {
    settleStep()
    reply = undefined
    assistantSeen = false
    findSelect.closeFind()
    pane.clear((b) => b.kind === "banner")
    // The old session's calls and sub-agents are not shown under the new one.
    callBlocks.clear()
    subagents.reset()
  }

  let offEmergency: (() => void) | undefined
  let started = false

  const view: TranscriptView = {
    get runningTools() {
      return stepCalls.flatMap((b) => (b.startedAt !== undefined && !b.end ? [b.name] : []))
    },
    get capturing() {
      return !overlay && (findSelect.finding || pane.selected !== undefined)
    },
    start() {
      started = true
      renderer.open()
      terminal.enableMode(modes.mouse)
      // A crash or a signal still leaves the conversation on the normal screen.
      if (terminal instanceof ProcessTerminal) offEmergency = terminal.onEmergencyExit(printout)
      renderer.render()
    },
    requestRender: () => renderer.requestRender(),
    render: () => renderer.render(),
    setTheme(next, nextGlyphs) {
      theme = next
      host.theme = next
      host.glyphs = nextGlyphs
      renderer.context = { ...renderer.context, theme: next, glyphs: nextGlyphs }
      pane.invalidate()
      renderer.redraw()
    },
    redraw: () => renderer.redraw(),
    openOverlay() {
      overlay = true
      // The overlay takes the mouse: a drag under way would never see its release.
      mouseHandlers.stopDrag()
      mouseHandlers.disarm()
    },
    closeOverlay() {
      overlay = false
      renderer.redraw()
    },
    requestOverlayRender: () => renderer.requestRender(),
    redrawOverlay: () => renderer.redraw(),
    renderOverlay: () => renderer.render(),
    stop() {
      subagents.stop()
      mouseHandlers.stopEdgeScroll()
      offEmergency?.()
      if (!started) return
      started = false
      terminal.disableMode(modes.mouseDrag)
      terminal.disableMode(modes.mouse)
      renderer.close()
      terminal.write(printout())
    },

    banner: (line) =>
      add(
        typeof line === "string"
          ? fixedLine("banner", line)
          : new LinesBlock("banner", (width, t) => [truncateToWidth(line(t), width, glyphs.more)]),
      ),
    user(m) {
      // A message sent: the selection has done its work (and Esc goes back to stopping turns).
      pane.clearText()
      add(userBlock(m, messageTimestamp(m) ?? Date.now()))
    },
    reasoningDelta(text) {
      if (!text) return
      if (!reasoning) {
        // Thinking after some text: that text is a reply of its own, before it.
        if (reply?.source.trim()) {
          reply.finish()
          reply = undefined
        }
        reasoning = new ReasoningBlock("", undefined, Date.now(), true, firstAssistantTime())
        pane.add(reasoning)
      }
      reasoning.append(text)
      pane.changed()
    },
    replyDelta(text) {
      // Empty deltas create no visible reply and cannot claim a clock or end thinking.
      if (!reply && !text.trim()) return
      endReasoning()
      if (!reply) {
        reply = new ReplyBlock("", true, host.hyperlinks, firstAssistantTime())
        pane.add(reply)
        markToolTrees()
      }
      reply.append(text)
      pane.changed()
    },
    replyEnd(calls) {
      let shown = endReasoning()
      if (reply) {
        reply.finish()
        if (reply.source.trim()) shown = true
        else pane.remove(reply)
        reply = undefined
      }
      // The calls take their places now, in call order, and show once they start.
      for (const c of calls) {
        if (callBlocks.has(c.id)) continue
        const b = new ToolBlock(c.id, c.name, c.args, host.sessionId())
        callBlocks.set(c.id, b)
        stepCalls.push(b)
        pane.add(b)
      }
      markToolTrees()
      return shown
    },
    toolStart(id, name, args, at) {
      let b = callBlocks.get(id)
      if (!b) {
        b = new ToolBlock(id, name, args, host.sessionId())
        callBlocks.set(id, b)
        stepCalls.push(b)
        pane.add(b)
      }
      b.name = name
      b.args = args
      if (!b.started) b.timestamp = firstAssistantTime()
      b.startedAt = at
      b.touch()
      markToolTrees()
      pane.changed()
    },
    toolUpdate(id, partial) {
      const b = callBlocks.get(id)
      if (!b || b.end) return
      b.partial = partial
      b.touch()
    },
    toolEnd(id, end) {
      const b = callBlocks.get(id)
      if (!b) return false
      // A rejected call can become visible without ever starting.
      if (!b.started) b.timestamp = firstAssistantTime()
      b.end = end
      b.touch()
      pane.changed()
      boundary.clear()
      regroup(b)
      markToolTrees()
      return true
    },
    turnEnd() {
      assistantSeen = false
      settleStep()
      subagents.tick()
      return false
    },
    subagentEvent: subagents.event,
    notice,
    commandEcho(line) {
      add(new LinesBlock("command", (width, t) => commandEchoLines(t, line, width), line))
    },
    commandOutput(level, text) {
      const last = pane.last?.kind
      // Right after its command it hangs under the echo; on its own it is a notice.
      if (last !== "command" && last !== "command-output") return notice(level, text)
      add(new LinesBlock("command-output", (width, t) => commandOutputLines(t, level, text, width), text))
    },
    dialogEcho: (draw) =>
      add(
        new LinesBlock(
          "dialog",
          (width) => draw(width),
          stripAnsi(draw(Number.POSITIVE_INFINITY).join("\n")),
        ),
      ),
    openSession(boundary, messages: Message[], switched, compactionInfo) {
      if (switched) clearTranscript()
      add(new LinesBlock("history", (w, t) => [sessionBoundary(t, boundary, w)], ""))
      for (const b of historyBlocks(messages, env, {
        compactionInfo,
        hyperlinks: host.hyperlinks,
        noticeBlock,
        sessionId: () => host.sessionId(),
        terminal,
      }))
        pane.add(b)
      markToolTrees()
      renderer.requestRender()
    },
    leaveSession() {
      assistantSeen = false
      settleStep()
      endReasoning()
      reply?.finish()
      reply = undefined
    },
    detailNote(level: ToolDetailLevel) {
      const cycle = keys.label("tool-output")
      return `Tool output: ${level} (every tool call; folded ones keep theirs${cycle ? `; ${cycle} cycles` : ""})`
    },
    handleInput(e) {
      if (overlay) return false
      if (e.type === "mouse") return mouseHandlers.mouse(e)
      if (e.type === "focus") return false
      if (findSelect.finding) return findSelect.findKey(e)
      if (pane.selected && findSelect.selectKey(e)) return true
      return findSelect.transcriptKey(e)
    },
    takeFirst(e) {
      // Esc clears selected text before it does anything else (closing the find bar or a list,
      // leaving the search, stopping a turn).
      if (overlay || !pane.hasText || !keys.is(e, "text.clear")) return false
      pane.clearText()
      return true
    },
  }
  return view
}
