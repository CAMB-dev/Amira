import {
  type InputEvent,
  LineInput,
  type Terminal,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import type { Block, BlockEnv } from "../blocks/base.ts"
import { copyToClipboard } from "../clipboard.ts"
import { glyphs } from "../glyphs.ts"
import { fitHint } from "../hint.ts"
import type { Keybindings } from "../keybindings.ts"
import { isActive } from "../subagents.ts"
import type { TranscriptPane } from "../transcript-pane.ts"

const FIND_QUERY_ROOM = 16

export interface FindSelectDeps {
  pane: TranscriptPane
  env: (width: number) => BlockEnv
  theme: Theme
  keys: Keybindings
  render: () => void
  showNote: (text: string) => void
  terminal: Terminal
  editorEmpty: () => boolean
  openSubagent?: (id: string) => void
}

export function createFindSelect(deps: FindSelectDeps) {
  const { editorEmpty, env, keys, openSubagent, pane, render, showNote, terminal, theme } = deps
  const findInput = new LineInput()
  let finding = false

  function closeFind(): void {
    finding = false
    findInput.value = ""
    pane.clearFind()
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
    if (openSubagent && b.subagents(e).length) return "sub-agent"
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

  /** Scrolling keys, in any state of the view. */
  function scrollKey(e: InputEvent): boolean {
    if (keys.is(e, "scroll.up")) pane.scrollBy(-1)
    else if (keys.is(e, "scroll.down")) pane.scrollBy(1)
    else if (keys.is(e, "scroll.page-up")) pane.pageUp()
    else if (keys.is(e, "scroll.page-down")) pane.pageDown()
    else return false
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
    else if (keys.is(e, "select.copy")) copyToClipboard(terminal, pane.codeText(), "the code block", showNote)
    else if (keys.is(e, "select.toggle") || keys.is(e, "select.open")) {
      const back = keys.label("select.exit")
      showNote(`A code block does not fold${back ? `; ${back} goes back to the reply` : ""}.`)
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
        render()
      }
      pane.selectCode(0)
    } else if (what === "sub-agent") {
      const list = block.subagents(renv)
      // The one still running, else the latest.
      const target = list.findLast(isActive) ?? list[list.length - 1]!
      openSubagent?.(target.id)
    } else showNote(`Nothing in this ${block.label} opens: no code blocks, no sub-agents.`)
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
      } else showNote(`Nothing in this ${block.label} folds.`)
    } else if (keys.is(e, "select.open")) openBlock(block, renv)
    else if (keys.is(e, "select.copy"))
      copyToClipboard(terminal, block.copyText(), `the ${block.label}`, showNote)
    else {
      // Typing goes back to the input.
      if (e.type === "paste" || (e.type === "key" && e.text !== undefined && !e.ctrl && !e.alt))
        pane.select(undefined)
      return false
    }
    return true
  }

  function transcriptKey(e: InputEvent): boolean {
    // Home, End and typing belong to the input unless it is empty.
    const plain = e.type === "key" && !e.ctrl && !e.alt
    if (plain && (e.name === "home" || e.name === "end" || e.text !== undefined) && !editorEmpty())
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

  return {
    closeFind,
    codeKey,
    findBar,
    findKey,
    get finding() {
      return finding
    },
    openBlock,
    opens,
    position,
    scrollKey,
    selectBar,
    selectKey,
    transcriptKey,
  }
}
