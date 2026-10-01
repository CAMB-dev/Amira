import { type MouseInput, modes, osc, type Terminal } from "@amira/tui-kit"
import type { TranscriptPane } from "../transcript-pane.ts"

const WHEEL_ROWS = 3
const EDGE_SCROLL_MS = 40
const EDGE_SCROLL_RAMP = 10
const EDGE_SCROLL_MAX = 6
/** Presses on one cell this close together make a double or triple click. */
const MULTI_CLICK_MS = 400
/** Copies longer than this (in UTF-16 units) may be more than a terminal takes through OSC 52. */
const OSC52_SAFE = 100_000

export interface MouseDeps {
  pane: TranscriptPane
  paneRows: () => number
  requestRender: () => void
  showNote: (text: string) => void
  terminal: Terminal
}

export function createMouse(deps: MouseDeps) {
  const { pane, paneRows, requestRender, showNote, terminal } = deps

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
    const direction = y === undefined ? 0 : y <= 0 && leftTop ? -1 : y >= paneRows() ? 1 : 0
    if (direction === edgeDirection) return
    edgeDirection = direction
    clearInterval(edgeTimer)
    edgeTimer = undefined
    if (!direction) return
    let ticks = 0
    const tick = () => {
      pane.scrollBy(direction * Math.min(EDGE_SCROLL_MAX, 1 + Math.floor(ticks++ / EDGE_SCROLL_RAMP)))
      requestRender()
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
    showNote(`Copied ${n} character${n === 1 ? "" : "s"}${big}`)
  }

  function mouse(e: MouseInput): boolean {
    if (e.action === "wheel") {
      if (e.button === "up") pane.scrollBy(-WHEEL_ROWS)
      else if (e.button === "down") pane.scrollBy(WHEEL_ROWS)
      return true
    }
    if (e.action === "press" && (e.button === "right" || e.button === "middle")) {
      // The terminal hands every click to the app while it reports the mouse; say how to paste.
      showNote(
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
      armed = e.y < paneRows()
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

  return {
    copySelection,
    disarm: () => {
      armed = false
    },
    mouse,
    stopEdgeScroll: () => edgeScroll(undefined),
    stopDrag,
  }
}
