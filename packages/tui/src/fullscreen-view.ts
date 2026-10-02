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
  exploredRun,
  fixedLine,
  LinesBlock,
  ReasoningBlock,
  ReplyBlock,
  SubagentGroupBlock,
  ToolBlock,
  userBlock,
} from "./blocks.ts"
import { commandEchoLines } from "./format.ts"
import { createFindSelect } from "./fullscreen/find-select.ts"
import { historyBlocks } from "./fullscreen/history-blocks.ts"
import { createMouse } from "./fullscreen/mouse.ts"
import { glyphs } from "./glyphs.ts"
import { sessionBoundary } from "./history.ts"
import {
  endNode,
  isActive,
  type SpawnGroups,
  type SubagentNode,
  startedNode,
  stateNode,
  trackGroup,
  updateNode,
} from "./subagents.ts"
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
  const { terminal, theme, keys } = host
  const pane = new TranscriptPane()
  /** Every sub-agent seen, by id; tool calls draw theirs from here. */
  const nodes = new Map<string, SubagentNode>()
  /** Spawn groups of the sub-agents seen, as their latest event had them. */
  const groups: SpawnGroups = new Map()
  /** Tool calls by id, for their sub-agents; kept after their turn. */
  const callBlocks = new Map<string, ToolBlock>()
  /** The block each sub-agent shows in, by its id: the call that started it (or its top ancestor), or one of its own. */
  const owners = new Map<string, Block>()
  /** The block of each spawn group whose members started without a call of this session. */
  const groupBlocks = new Map<string, SubagentGroupBlock>()
  /** Calls of the running step, in call order. */
  let stepCalls: ToolBlock[] = []
  let reply: ReplyBlock | undefined
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
      width,
      now: Date.now(),
      spinner: host.spinner.glyph,
      detail: host.detail(),
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
    theme,
  })

  /** Makes the exploring calls in a row around `block` one "Explored" row. */
  function regroup(block: Block): void {
    const run = exploredRun(pane.blocks, block, env(terminal.columns))
    if (!run) return
    pane.insertAfter(run.replaces.at(-1)!, run.group)
    const selected = pane.selected
    for (const b of run.replaces) pane.remove(b)
    if (selected && run.replaces.includes(selected)) pane.selected = run.group
  }

  const root = new View((width, ctx) => {
    // Covered by a full-screen overlay, the transcript's images are not placed: they are cleared.
    if (overlay) return host.overlay.render(width, ctx)
    const bar = findSelect.finding
      ? [findSelect.findBar(width)]
      : pane.selected
        ? [findSelect.selectBar(width)]
        : []
    const budget = Math.max(1, ctx.rows - MIN_TRANSCRIPT_ROWS - 1 - bar.length)
    const bottom = host.bottom(width, ctx, budget)
    paneRows = Math.max(1, ctx.rows - bottom.length - bar.length - 1)
    const rows = pane.render(env(width), paneRows)
    // The transcript is at the top of the screen: its rows are the screen's.
    for (const p of pane.placements) ctx.place?.(p)
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
    return [...rows, below, ...bar, ...bottom]
  })
  const renderer = new FullScreenRenderer(terminal, root, {
    synchronizedOutput: host.capabilities.synchronizedOutput,
    theme,
    frameIntervalMs: FRAME_MS,
  })

  const mouseHandlers = createMouse({
    pane,
    paneRows: () => paneRows,
    requestRender: () => renderer.requestRender(),
    showNote: (text) => host.showNote(text),
    terminal,
  })

  const endHint = () => {
    const end = keys.label("scroll.bottom")
    return end ? ` · ${end} follows` : ""
  }

  /** Redraws once a second while sub-agents run, so their elapsed time moves. */
  let subagentTimer: ReturnType<typeof setInterval> | undefined
  const tickSubagents = () => {
    const running = [...nodes.values()].some(isActive)
    if (running && !subagentTimer) subagentTimer = setInterval(() => renderer.requestRender(), 1000)
    else if (!running && subagentTimer) {
      clearInterval(subagentTimer)
      subagentTimer = undefined
    }
  }

  /** The block a sub-agent shows in: its top ancestor's call, or a block of its own. */
  const ownerOf = (n: SubagentNode): Block | undefined => owners.get(n.id)

  function add(block: Block): void {
    pane.add(block)
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
    const color = isColorEnabled()
    const lines = pane.printout(env(terminal.columns))
    const rows = lines.map((l) => `${presentEmoji(closeStyles(color ? l : stripColors(l)))}\r\n`).join("")
    return `\r\n${rows}\r\n`
  }

  /** The transcript starts afresh for another session: only the banner stays. */
  function clearTranscript(): void {
    settleStep()
    reply = undefined
    findSelect.closeFind()
    pane.clear((b) => b.kind === "banner")
    // The old session's calls and sub-agents are not shown under the new one.
    nodes.clear()
    groups.clear()
    callBlocks.clear()
    owners.clear()
    groupBlocks.clear()
    tickSubagents()
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
      if (subagentTimer) clearInterval(subagentTimer)
      subagentTimer = undefined
      mouseHandlers.stopEdgeScroll()
      offEmergency?.()
      if (!started) return
      started = false
      terminal.disableMode(modes.mouseDrag)
      terminal.disableMode(modes.mouse)
      renderer.close()
      terminal.write(printout())
    },

    banner: (line) => add(fixedLine("banner", line)),
    user(m) {
      // A message sent: the selection has done its work (and Esc goes back to stopping turns).
      pane.clearText()
      add(userBlock(m))
    },
    reasoningDelta(text) {
      if (!reasoning) {
        // Thinking after some text: that text is a reply of its own, before it.
        if (reply?.source.trim()) {
          reply.finish()
          reply = undefined
        }
        reasoning = new ReasoningBlock("", undefined, Date.now(), true)
        pane.add(reasoning)
      }
      reasoning.append(text)
      pane.changed()
    },
    replyDelta(text) {
      endReasoning()
      if (!reply) {
        reply = new ReplyBlock("", true, host.hyperlinks)
        pane.add(reply)
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
      b.startedAt = at
      b.touch()
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
      b.end = end
      b.touch()
      pane.changed()
      regroup(b)
      return true
    },
    turnEnd() {
      settleStep()
      tickSubagents()
      return false
    },
    subagentEvent(e) {
      const mine = e.sessionId === host.sessionId() || nodes.has(e.sessionId)
      switch (e.type) {
        case "subagent.start": {
          if (!mine) return false
          const node = startedNode(e)
          nodes.set(node.id, node)
          const main = node.parent === host.sessionId()
          const call = main && node.toolCallId ? callBlocks.get(node.toolCallId) : undefined
          const owner = owners.get(node.parent) ?? call
          if (owner) {
            owners.set(node.id, owner)
            owner.touch()
          } else if (main) {
            // Started without a call of this session (by a command, say): a block of its own,
            // shared by the members of its spawn group (a workflow's agents, a swarm's members).
            const shared = node.groupId !== undefined ? groupBlocks.get(node.groupId) : undefined
            if (shared) {
              shared.roots.push(node.id)
              owners.set(node.id, shared)
              shared.touch()
            } else {
              const group = new SubagentGroupBlock(node.id)
              owners.set(node.id, group)
              if (node.groupId !== undefined) groupBlocks.set(node.groupId, group)
              add(group)
            }
          }
          break
        }
        case "subagent.end": {
          const node = nodes.get(e.data.childSessionId)
          if (!node) return false
          endNode(node, e)
          ownerOf(node)?.touch()
          break
        }
        case "subagent.state": {
          const node = nodes.get(e.data.childSessionId)
          if (!node) return false
          stateNode(node, e)
          ownerOf(node)?.touch()
          break
        }
        case "group.start":
        case "group.update":
        case "group.end": {
          if (!mine || !trackGroup(groups, e)) return false
          // A compact group's line is drawn by the blocks its members show in.
          for (const n of nodes.values()) if (n.groupId === e.data.group.id) ownerOf(n)?.touch()
          renderer.requestRender()
          return true
        }
        case "budget.exceeded":
          notice("warning", `Budget spent (${e.data.tokens} tokens); sub-agents were stopped.`)
          return true
        default: {
          const node = nodes.get(e.sessionId)
          if (!node) return false
          updateNode(node, e, host.presenters)
          ownerOf(node)?.touch()
          return true
        }
      }
      tickSubagents()
      return true
    },
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
      renderer.requestRender()
    },
    leaveSession() {
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
