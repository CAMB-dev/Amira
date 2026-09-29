import type { Message, ToolDetailLevel, ToolResult } from "@amira/api"
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
  stripAnsi,
  stripColors,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import {
  type Block,
  type BlockEnv,
  type BlockImages,
  fixedLine,
  LinesBlock,
  ReplyBlock,
  SubagentGroupBlock,
  ToolBlock,
  userBlock,
} from "./blocks.ts"
import { commandEchoLines, compactTokens } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { fitHint } from "./hint.ts"
import { historySeparator } from "./history.ts"
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
import { commandOutputLines, type NoticeLevel, noticeLines } from "./transcript.ts"
import { lastReply, TranscriptPane } from "./transcript-pane.ts"
import { type TranscriptView, View, type ViewHost } from "./view.ts"

/** The renderer's shortest time between frames. */
const FRAME_MS = 16
/** Rows the transcript keeps when a dialog wants the screen. */
const MIN_TRANSCRIPT_ROWS = 3
/** Rows one notch of the mouse wheel scrolls. */
const WHEEL_ROWS = 3

/**
 * The full-screen view (D84): the conversation is kept as blocks on the alternate screen and
 * drawn into a scrollable viewport above the same bottom area the inline view has. Blocks
 * change in place (a call finishing, its sub-agents moving on, also in the background after
 * the turn), fold and unfold, and are drawn again at any width. The wheel, PgUp/PgDn and
 * Home/End scroll; Ctrl+F finds; Ctrl+↑ selects blocks to fold or copy (OSC 52). On exit the
 * whole conversation is printed to the normal screen, as the inline view would have left it.
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
  let overlay = false
  const findInput = new LineInput()
  let finding = false
  /** Rows of the transcript in the last frame, for mouse clicks. */
  let paneRows = 0

  /** Images of replies, drawn in the transcript where the terminal can (D83). */
  const images: BlockImages | undefined = host.images && {
    loader: host.images,
    changed: () => renderer.requestRender(),
  }

  const env = (width: number): BlockEnv => ({
    theme,
    width,
    now: Date.now(),
    spinner: host.spinner.glyph,
    detail: host.detail(),
    presenters: host.presenters,
    hyperlinks: host.hyperlinks,
    nodes,
    groups,
    ...(images ? { images } : {}),
  })

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
    // The row under the transcript says when there is more below.
    const below = pane.following
      ? ""
      : truncateToWidth(
          pane.unseen
            ? theme.accent(`  ↓ new output${endHint()}`)
            : theme.muted(`  ↓ more below${endHint()}`),
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
    const hint = fitHint(
      [
        count && { text: count, priority: 5 },
        next && { text: `${next} older`, priority: 3 },
        prev && { text: `${prev} newer`, priority: 2 },
        close && { text: `${close} close`, priority: 4 },
      ],
      Math.max(10, Math.floor(width / 2)),
    )
    const head = `${theme.accent(glyphs.search)} find ${theme.muted(glyphs.searchPrompt)} `
    const room = Math.max(4, width - visibleWidth(head) - visibleWidth(hint) - 2)
    const input = findInput.render(room, theme, { focused: true, placeholder: "text in the transcript" })
    const pad = " ".repeat(Math.max(1, room - visibleWidth(input) + 2))
    return truncateToWidth(`${head}${input}${pad}${theme.muted(hint)}`, width, glyphs.more)
  }

  function selectBar(width: number): string {
    const b = pane.selected!
    const fold = keys.label("select.toggle")
    const copy = keys.label("select.copy")
    const move = keys.pairLabel("select.prev", "select.next")
    const back = keys.label("select.exit")
    const foldable = b.foldable(env(width))
    const hint = fitHint(
      [
        { text: `${glyphs.pointer} ${b.kind} block ${b.index + 1} of ${pane.blocks.length}`, priority: 6 },
        foldable && fold && { text: `${fold} fold`, priority: 5 },
        copy && { text: `${copy} copy`, priority: 4 },
        move && { text: `${move} move`, priority: 2 },
        back && { text: `${back} back`, priority: 3 },
      ],
      width,
    )
    return theme.muted(hint)
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

  function notice(level: NoticeLevel, text: string): void {
    add(new LinesBlock("notice", (width, t) => noticeLines(t, level, text, width), text))
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

  /** The text of the rows as they stay on the normal screen: styles closed, colors as allowed. */
  function printout(): string {
    const color = isColorEnabled()
    const lines = pane.printout(env(terminal.columns))
    return lines.map((l) => `${closeStyles(color ? l : stripColors(l))}\r\n`).join("")
  }

  function copy(text: string, what: string): void {
    if (!text.trim()) {
      host.showNote(`Nothing to copy in ${what}.`)
      return
    }
    terminal.write(osc.clipboard(text))
    host.showNote(
      `Copied ${what} (${compactTokens(text.length)} characters) to the clipboard. Not there? Shift+drag selects text.`,
    )
  }

  function closeFind(): void {
    finding = false
    findInput.value = ""
    pane.clearFind()
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
        `Clicks go to Amira here: Shift+${e.button}-click (or Ctrl+V) pastes, Shift+drag selects text.`,
      )
      return true
    }
    if (e.action !== "press" || e.button !== "left" || e.y >= paneRows || finding) return true
    // With a draft in the input a click (often just the one focusing the window) must not take
    // the keyboard from it: Enter still sends and typing still types.
    if (!host.editorEmpty()) return true
    const hit = pane.blockAt(e.y)
    if (!hit) return true
    // A second click on the head of the selected block folds it.
    const renv = env(terminal.columns)
    if (hit.block === pane.selected && hit.line === 0) {
      if (hit.block.foldable(renv)) hit.block.toggleFold(renv)
    } else pane.selected = hit.block
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

  function selectKey(e: InputEvent): boolean {
    const block = pane.selected!
    const renv = env(terminal.columns)
    if (keys.is(e, "select.exit")) pane.selected = undefined
    else if (keys.is(e, "select.prev")) pane.selectPrev()
    else if (keys.is(e, "select.next")) pane.selectNext()
    else if (keys.is(e, "select.toggle")) {
      if (block.foldable(renv)) {
        block.toggleFold(renv)
        pane.reveal(block)
      } else host.showNote("Nothing in this block folds.")
    } else if (keys.is(e, "select.copy")) copy(block.copyText(), `the ${block.kind} block`)
    else {
      // Typing goes back to the input.
      if (e.type === "paste" || (e.type === "key" && e.text !== undefined && !e.ctrl && !e.alt))
        pane.selected = undefined
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
      pane.selected = undefined
      findInput.value = ""
    } else if (keys.is(e, "copy.reply")) copy(lastReply(pane)?.copyText() ?? "", "the last reply")
    else return false
    return true
  }

  let offEmergency: (() => void) | undefined
  let started = false

  const view: TranscriptView = {
    get toolsRunning() {
      return stepCalls.filter((b) => b.startedAt !== undefined && !b.end).length
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
      offEmergency?.()
      if (!started) return
      started = false
      terminal.disableMode(modes.mouse)
      renderer.close()
      terminal.write(printout())
    },

    banner: (line) => add(fixedLine("banner", line)),
    user: (m) => add(userBlock(m)),
    replyDelta(text) {
      if (!reply) {
        reply = new ReplyBlock("", true, host.hyperlinks)
        pane.add(reply)
      }
      reply.append(text)
      pane.changed()
    },
    replyEnd(calls) {
      let shown = false
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
      add(
        new LinesBlock(
          "command-output",
          (width, t) => {
            const style = level === "error" ? t.error : level === "warning" ? t.warning : t.text
            return commandOutputLines(style, t.muted, text, width)
          },
          text,
        ),
      )
    },
    dialogEcho: (draw) =>
      add(
        new LinesBlock(
          "dialog",
          (width) => draw(width),
          stripAnsi(draw(Number.POSITIVE_INFINITY).join("\n")),
        ),
      ),
    history(messages: Message[], session) {
      const results = new Map<string, ToolResult>()
      for (const m of messages) {
        if (m.role === "toolResult") results.set(m.toolCallId, { content: m.content, isError: m.isError })
      }
      for (const m of messages) {
        if (m.role === "user") pane.add(userBlock(m))
        else if (m.role === "assistant") {
          for (const b of m.content) {
            if (b.type === "text" && b.text.trim()) pane.add(new ReplyBlock(b.text, false, host.hyperlinks))
            else if (b.type === "toolCall") {
              const call = new ToolBlock(b.id, b.name, b.args, host.sessionId())
              const result = results.get(b.id)
              call.end = result ? { result } : { result: { content: [], isError: true }, rejected: "aborted" }
              pane.add(call)
            }
          }
        }
      }
      add(new LinesBlock("history", (_w, t) => [historySeparator(t, session)], ""))
    },
    leaveSession() {
      settleStep()
      reply?.finish()
      reply = undefined
    },
    hints() {
      const find = keys.label("find")
      const select = keys.label("select.start")
      return [
        ...(find ? [{ text: `${find} find`, priority: 0.5 }] : []),
        ...(select ? [{ text: `${select} select`, priority: 0.4 }] : []),
      ]
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
  }
  return view
}
