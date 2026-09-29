import type { Message, ToolDetailLevel, ToolResult } from "@amira/api"
import { isSummaryMessage } from "@amira/core"
import {
  closeStyles,
  FullScreenRenderer,
  type InputEvent,
  isColorEnabled,
  LineInput,
  type MouseInput,
  modes,
  osc,
  ProcessTerminal,
  presentEmoji,
  stripAnsi,
  stripColors,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import {
  type Block,
  type BlockEnv,
  type BlockImages,
  type BlockRenders,
  DetailNoticeBlock,
  exploredRun,
  fixedLine,
  groupExplored,
  LinesBlock,
  ReasoningBlock,
  ReplyBlock,
  SubagentGroupBlock,
  SummaryBlock,
  ToolBlock,
  userBlock,
} from "./blocks.ts"
import { copyToClipboard } from "./clipboard.ts"
import { commandEchoLines } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint } from "./hint.ts"
import { sessionBoundary, summaryText } from "./history.ts"
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
import { commandOutputLines, type NoticeLevel, noticeLines, replyEndNotice } from "./transcript.ts"
import { TranscriptPane } from "./transcript-pane.ts"
import { type TranscriptView, View, type ViewHost } from "./view.ts"

/** The renderer's shortest time between frames. */
const FRAME_MS = 16
/** Rows the transcript keeps when a dialog wants the screen. */
const MIN_TRANSCRIPT_ROWS = 3
/** Rows one notch of the mouse wheel scrolls. */
const WHEEL_ROWS = 3
/** How often a drag held at the top or bottom edge scrolls the transcript. */
const EDGE_SCROLL_MS = 40
/** Held at an edge, the drag scrolls a row more per step every this many steps, up to EDGE_SCROLL_MAX rows. */
const EDGE_SCROLL_RAMP = 10
const EDGE_SCROLL_MAX = 6
/** Presses on one cell this close together make a double or triple click. */
const MULTI_CLICK_MS = 400
/** Copies longer than this (in UTF-16 units) may be more than a terminal takes through OSC 52. */
const OSC52_SAFE = 100_000
/** Columns the find bar keeps for its query, at the least, before its keys. */
const FIND_QUERY_ROOM = 16

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
  const findInput = new LineInput()
  let finding = false
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
    const bar = finding ? [findBar(width)] : pane.selected ? [selectBar(width)] : []
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

  const endHint = () => {
    const end = keys.label("scroll.bottom")
    return end ? ` · ${end} follows` : ""
  }

  function findBar(width: number): string {
    const count = pane.matchCount
      ? `${pane.matchPosition}/${pane.matchCount}`
      : findInput.value
        ? "no matches"
        : ""
    const next = keys.label("find.next")
    const prev = keys.label("find.prev")
    const close = keys.label("find.close")
    const head = `${theme.accent(glyphs.search)} find ${theme.muted(glyphs.searchPrompt)} `
    // The query keeps room for what is typed (and the caret); the keys get the rest, the
    // least needed going first.
    const query = Math.max(FIND_QUERY_ROOM, visibleWidth(findInput.value) + 1)
    const hint = fitHint(
      [
        count && { text: count, priority: 5 },
        next && { text: `${next} older`, priority: 3 },
        prev && { text: `${prev} newer`, priority: 2 },
        close && { text: `${close} close`, priority: 4 },
      ],
      Math.max(0, width - visibleWidth(head) - query - 2),
    )
    const room = Math.max(4, width - visibleWidth(head) - visibleWidth(hint) - 2)
    const input = findInput.render(room, theme, { focused: true, placeholder: "text in the transcript" })
    const pad = " ".repeat(Math.max(1, room - visibleWidth(input) + 2))
    return truncateToWidth(`${head}${input}${pad}${theme.muted(hint)}`, width, glyphs.more)
  }

  /** The blocks a selection moves over (those with rows), and where `b` is among them. */
  function position(b: Block, e: BlockEnv): string {
    let at = 0
    let count = 0
    for (const x of pane.blocks) {
      if (!pane.lines(x, e).length) continue
      count++
      if (x === b) at = count
    }
    return `${at} of ${count}`
  }

  /** What the open key does on a block: go into a reply's code blocks, open the sub-agent viewer. */
  function opens(b: Block, e: BlockEnv): "code blocks" | "sub-agent" | undefined {
    if (pane.codeBlocks(b).length) return "code blocks"
    if (host.openSubagent && b.subagents(e).length) return "sub-agent"
    return undefined
  }

  function selectBar(width: number): string {
    const b = pane.selected!
    const e = env(width)
    const fold = keys.label("select.toggle")
    const copy = keys.label("select.copy")
    const back = keys.label("select.exit")
    const open = keys.label("select.open")
    const code = pane.selectedCode
    // Moving between blocks is in the key reference (the help key).
    const items = code
      ? [
          {
            text: `${glyphs.pointer} code block ${code.index + 1} of ${code.count} in the reply`,
            priority: 6,
          },
          copy && { text: `${copy} copy`, priority: 5 },
          back && { text: `${back} reply`, priority: 5 },
        ]
      : [
          { text: `${glyphs.pointer} ${b.label} ${position(b, e)}`, priority: 6 },
          b.foldable(e) && fold && { text: `${fold} ${b.isFolded(e) ? "unfold" : "fold"}`, priority: 3 },
          open && opens(b, e) && { text: `${open} ${opens(b, e)}`, priority: 3 },
          copy && { text: `${copy} copy`, priority: 4 },
          back && { text: `${back} back`, priority: 5 },
        ]
    return theme.muted(fitHint(items, width))
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

  const copy = (text: string, what: string) => copyToClipboard(terminal, text, what, host.showNote)

  /** The transcript starts afresh for another session: only the banner stays. */
  function clearTranscript(): void {
    settleStep()
    reply = undefined
    closeFind()
    pane.clear((b) => b.kind === "banner")
    // The old session's calls and sub-agents are not shown under the new one.
    nodes.clear()
    groups.clear()
    callBlocks.clear()
    owners.clear()
    groupBlocks.clear()
    tickSubagents()
  }

  function closeFind(): void {
    finding = false
    findInput.value = ""
    pane.clearFind()
  }

  /** The last press of the left button, for double and triple clicks. */
  let lastPress: { x: number; y: number; at: number; count: number } | undefined
  /** Scrolls while a drag is held above or below the transcript. */
  let edgeTimer: ReturnType<typeof setInterval> | undefined
  let edgeDirection = 0
  /** Whether the drag was ever below the top row. */
  let leftTop = false
  /** Whether the left button went down in the transcript: its release copies. */
  let armed = false

  /**
   * Scrolls every EDGE_SCROLL_MS while the drag is held at the edge of the transcript: on its
   * top row (the top of the screen) up, under its last row down; a row at a time at first,
   * faster the longer it is held. `y` undefined stops.
   */
  function edgeScroll(y: number | undefined): void {
    // A drag along the top row, where it started, selects there: it scrolls once it came back.
    if (y !== undefined && y > 0) leftTop = true
    const direction = y === undefined ? 0 : y <= 0 && leftTop ? -1 : y >= paneRows ? 1 : 0
    if (direction === edgeDirection) return
    edgeDirection = direction
    clearInterval(edgeTimer)
    edgeTimer = undefined
    if (!direction) return
    let ticks = 0
    const tick = () => {
      pane.scrollBy(direction * Math.min(EDGE_SCROLL_MAX, 1 + Math.floor(ticks++ / EDGE_SCROLL_RAMP)))
      renderer.requestRender()
    }
    tick()
    edgeTimer = setInterval(tick, EDGE_SCROLL_MS)
  }

  /** The drag is over: no more motion reports, no more scrolling at the edges. */
  function stopDrag(): void {
    pane.endDrag()
    edgeScroll(undefined)
    terminal.disableMode(modes.mouseDrag)
  }

  /** Copies the selected text, if any, and says so. */
  function copySelection(): void {
    const text = pane.selectedText()
    if (!text) return
    terminal.write(osc.clipboard(text))
    const n = [...text].length
    const big =
      text.length > OSC52_SAFE ? " (a lot: some terminals drop that much; Shift+drag selects natively)" : ""
    host.showNote(`Copied ${n} character${n === 1 ? "" : "s"}${big}`)
  }

  function mouse(e: MouseInput): boolean {
    if (e.action === "wheel") {
      if (e.button === "up") pane.scrollBy(-WHEEL_ROWS)
      else if (e.button === "down") pane.scrollBy(WHEEL_ROWS)
      return true
    }
    if (e.action === "press" && (e.button === "right" || e.button === "middle")) {
      // The terminal hands every click to the app while it reports the mouse; say how to paste.
      host.showNote(
        `Clicks go to Amira here: Shift+${e.button}-click (or Ctrl+V) pastes, Shift+drag selects natively.`,
      )
      return true
    }
    if (e.button !== "left") return true
    /** Near the last press: a column off still makes a double click. */
    const near = (p: typeof lastPress) => p !== undefined && p.y === e.y && Math.abs(p.x - e.x) <= 1
    if (e.action === "press") {
      // A click clears the selection and does nothing else: the keyboard stays with the input.
      stopDrag()
      pane.clearText()
      const now = Date.now()
      const again = near(lastPress) && now - lastPress!.at <= MULTI_CLICK_MS
      const count = again ? (lastPress!.count % 3) + 1 : 1
      lastPress = { x: e.x, y: e.y, at: now, count }
      armed = e.y < paneRows
      if (!armed) return true
      pane.select(undefined)
      if (count === 2) pane.selectWord(e.y, e.x)
      else if (count === 3) pane.selectLine(e.y, e.x)
      else {
        pane.startDrag(e.y, e.x)
        leftTop = e.y > 0
        // Moves with the button held are reported from now on, until it is released.
        if (pane.dragging) terminal.enableMode(modes.mouseDrag)
      }
      return true
    }
    if (e.action === "drag") {
      if (!pane.dragging) return true
      // Moved off: the next press is no double click.
      if (!near(lastPress)) lastPress = undefined
      pane.dragTo(e.y, e.x)
      edgeScroll(e.y)
      return true
    }
    // Released: what this press selected goes to the clipboard.
    stopDrag()
    if (armed) copySelection()
    armed = false
    return true
  }

  function findKey(e: InputEvent): boolean {
    if (keys.is(e, "find.close")) closeFind()
    else if (keys.is(e, "find.next")) pane.stepMatch(-1)
    else if (keys.is(e, "find.prev")) pane.stepMatch(1)
    else if (scrollKey(e)) return true
    else {
      const before = findInput.value
      if (!findInput.handleInput(e)) return false
      if (findInput.value !== before) {
        if (findInput.value) pane.find(findInput.value)
        else pane.clearFind()
      }
    }
    return true
  }

  /** Keys while a code block of the selected reply is selected. */
  function codeKey(e: InputEvent): boolean {
    if (keys.is(e, "select.exit") || keys.is(e, "select.back")) pane.leaveCode()
    else if (keys.is(e, "select.prev")) pane.selectCode(-1)
    else if (keys.is(e, "select.next")) pane.selectCode(1)
    else if (keys.is(e, "select.copy")) copy(pane.codeText(), "the code block")
    else if (keys.is(e, "select.toggle") || keys.is(e, "select.open")) {
      const back = keys.label("select.exit")
      host.showNote(`A code block does not fold${back ? `; ${back} goes back to the reply` : ""}.`)
    } else return false
    return true
  }

  /** The open key on a block: into a reply's code blocks, or the viewer of its sub-agents. */
  function openBlock(block: Block, renv: BlockEnv): void {
    const what = opens(block, renv)
    if (what === "code blocks") {
      // Folded, long code is cut short: its code blocks are shown whole to be picked.
      if (block.isFolded(renv)) {
        block.toggleFold(renv)
        renderer.render()
      }
      pane.selectCode(0)
    } else if (what === "sub-agent") {
      const list = block.subagents(renv)
      // The one still running, else the latest.
      const target = list.findLast(isActive) ?? list[list.length - 1]!
      host.openSubagent?.(target.id)
    } else host.showNote(`Nothing in this ${block.label} opens: no code blocks, no sub-agents.`)
  }

  function selectKey(e: InputEvent): boolean {
    const block = pane.selected!
    const renv = env(terminal.columns)
    if (pane.selectedCode && codeKey(e)) return true
    if (keys.is(e, "select.exit")) pane.select(undefined)
    else if (keys.is(e, "select.prev")) pane.selectPrev()
    else if (keys.is(e, "select.next")) pane.selectNext()
    else if (keys.is(e, "select.toggle")) {
      if (block.foldable(renv)) {
        block.toggleFold(renv)
        pane.reveal(block)
      } else host.showNote(`Nothing in this ${block.label} folds.`)
    } else if (keys.is(e, "select.open")) openBlock(block, renv)
    else if (keys.is(e, "select.copy")) copy(block.copyText(), `the ${block.label}`)
    else {
      // Typing goes back to the input.
      if (e.type === "paste" || (e.type === "key" && e.text !== undefined && !e.ctrl && !e.alt))
        pane.select(undefined)
      return false
    }
    return true
  }

  /** Scrolling keys, in any state of the view. */
  function scrollKey(e: InputEvent): boolean {
    if (keys.is(e, "scroll.up")) pane.scrollBy(-1)
    else if (keys.is(e, "scroll.down")) pane.scrollBy(1)
    else if (keys.is(e, "scroll.page-up")) pane.pageUp()
    else if (keys.is(e, "scroll.page-down")) pane.pageDown()
    else return false
    return true
  }

  function transcriptKey(e: InputEvent): boolean {
    // Home, End and typing belong to the input unless it is empty.
    const plain = e.type === "key" && !e.ctrl && !e.alt
    if (plain && (e.name === "home" || e.name === "end" || e.text !== undefined) && !host.editorEmpty())
      return false
    if (scrollKey(e)) return true
    if (keys.is(e, "scroll.top")) pane.toTop()
    else if (keys.is(e, "scroll.bottom")) pane.follow()
    else if (keys.is(e, "select.start")) pane.selectPrev()
    else if (keys.is(e, "find")) {
      finding = true
      pane.select(undefined)
      findInput.value = ""
    } else return false
    return true
  }

  let offEmergency: (() => void) | undefined
  let started = false

  const view: TranscriptView = {
    get runningTools() {
      return stepCalls.flatMap((b) => (b.startedAt !== undefined && !b.end ? [b.name] : []))
    },
    get capturing() {
      return !overlay && (finding || pane.selected !== undefined)
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
      stopDrag()
      armed = false
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
      edgeScroll(undefined)
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
    openSession(boundary, messages: Message[], switched) {
      if (switched) clearTranscript()
      add(new LinesBlock("history", (w, t) => [sessionBoundary(t, boundary, w)], ""))
      const results = new Map<string, ToolResult>()
      for (const m of messages) {
        if (m.role === "toolResult") results.set(m.toolCallId, { content: m.content, isError: m.isError })
      }
      const blocks: Block[] = []
      for (const m of messages) {
        // A compaction's summary is a folded block of its own; the reply that took it goes with it.
        if (isSummaryMessage(m)) {
          if (m.role === "user") blocks.push(new SummaryBlock(summaryText(m)))
        } else if (m.role === "user") blocks.push(userBlock(m))
        else if (m.role === "assistant") {
          for (const b of m.content) {
            if (b.type === "thinking" && (b.text.trim() || b.redacted))
              blocks.push(new ReasoningBlock(b.text, undefined))
            else if (b.type === "text" && b.text.trim())
              blocks.push(new ReplyBlock(b.text, false, host.hyperlinks))
            else if (b.type === "toolCall") {
              const call = new ToolBlock(b.id, b.name, b.args, host.sessionId())
              const result = results.get(b.id)
              call.end = result ? { result } : { result: { content: [], isError: true }, rejected: "aborted" }
              blocks.push(call)
            }
          }
          // How the reply ended, when it did not end well: as the live transcript said it.
          const end = replyEndNotice(m)
          if (end) blocks.push(noticeBlock(end.level, end.text))
        }
      }
      for (const b of groupExplored(blocks, env(terminal.columns))) pane.add(b)
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
      if (e.type === "mouse") return mouse(e)
      if (e.type === "focus") return false
      if (finding) return findKey(e)
      if (pane.selected && selectKey(e)) return true
      return transcriptKey(e)
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
