import { expect, test } from "bun:test"
import {
  defaultTheme,
  FakeTerminal,
  ImageStore,
  type MouseInput,
  ScreenImage,
  surfaceTheme,
} from "@amira/tui-kit"
import { fakePayload } from "../../tui-kit/test/fake-images.ts"
import { setImagesIn } from "../src/blocks/base.ts"
import { type Block, type BlockEnv, LinesBlock, userBlock } from "../src/blocks.ts"
import { userBandPaddingIn } from "../src/format.ts"
import { createMouse } from "../src/fullscreen/mouse.ts"
import { stickyPromptLine, stickyPromptOverlay } from "../src/pane/sticky-prompt.ts"
import { gapBetween } from "../src/transcript.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const at = new Date(2026, 9, 10, 20, 9).getTime()
const prompt = (text: string) => userBlock({ role: "user", content: [{ type: "text", text }] }, at)
const output = (name: string, count: number) =>
  new LinesBlock("assistant", () => Array.from({ length: count }, (_, i) => `  ${name} ${i}`))
const env = (width: number, banded: boolean): BlockEnv => ({
  theme: banded ? { ...defaultTheme, ...surfaceTheme("dark") } : defaultTheme,
  width,
  now: at,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
})
const event = (action: MouseInput["action"], y: number, x = 4): MouseInput => ({
  type: "mouse",
  action,
  button: "left",
  x,
  y,
  ctrl: false,
  alt: false,
  shift: false,
})

for (const turns of [2, 3]) {
  for (const width of [30, 60, 100]) {
    for (const banded of [false, true]) {
      for (const height of [8, 16]) {
        test(`${turns} turns, width ${width}, userBg ${banded}, height ${height}: every ANSI frame pushes and reverses one row`, () => {
          const e = env(width, banded)
          const pane = new TranscriptPane()
          const blocks: Block[] = [
            prompt("A first\nA second\nA third"),
            output("A", 10),
            prompt("B short"),
            output("B", turns === 2 ? 30 : 10),
          ]
          if (turns === 3)
            blocks.push(prompt("C first\nC second\nC third\nC fourth\nC fifth"), output("C", 30))
          for (const block of blocks) pane.add(block)
          const all: string[] = []
          const bands: { block: LinesBlock; start: number; padding: number; lines: string[] }[] = []
          let previous: Block | undefined
          for (const block of blocks) {
            if (previous && gapBetween(previous.kind, block.kind)) all.push("")
            const real = pane.lines(block, e)
            if (block instanceof LinesBlock && block.prompt !== undefined) {
              const padding = userBandPaddingIn(real)
              bands.push({
                block,
                start: all.length,
                padding,
                lines:
                  height < 12
                    ? [stickyPromptLine(block, e)]
                    : real.length - 2 * padding > 3
                      ? real.slice(0, padding + 3)
                      : real,
              })
            }
            all.push(...real)
            previous = block
          }
          pane.render(e, height)
          pane.toTop()
          const frames: string[][] = []
          for (let offset = 0; offset <= all.length - height; offset++) {
            if (offset) pane.scrollBy(1)
            const frame = pane.render(
              e,
              height,
              (layout) => stickyPromptOverlay(pane.blocks, layout, e, height).lines,
            )
            const current = bands.findLast((band) => band.start <= offset)!
            const next = bands.find((band) => band.start > offset)
            const entering = height < 12 && offset <= current.start + current.padding
            const visible = entering
              ? 0
              : next
                ? Math.min(current.lines.length, next.start - offset)
                : current.lines.length
            const expected = all.slice(offset, offset + height)
            const suffix = current.lines.slice(current.lines.length - visible)
            expected.splice(0, suffix.length, ...suffix)
            expect(frame).toEqual(expected)
            if (offset === current.start) expect(frame).toEqual(all.slice(offset, offset + height))
            for (const name of ["A", "B", "C"])
              expect(
                frame.filter((row) => row.includes(`${name} ${name === "B" ? "short" : "first"}`)).length,
              ).toBeLessThanOrEqual(1)
            expect(frame).toHaveLength(height)
            expect(pane.rowsBelow).toBe(all.length - height - offset)
            // Every uncovered row advances by exactly one, regardless of overlay height.
            if (offset)
              expect(frame.slice(current.lines.length)).toEqual(
                all.slice(offset + current.lines.length, offset + height),
              )
            frames.push(frame)
          }
          for (let offset = frames.length - 2; offset >= 0; offset--) {
            pane.scrollBy(-1)
            expect(
              pane.render(e, height, (layout) => stickyPromptOverlay(pane.blocks, layout, e, height).lines),
            ).toEqual(frames[offset]!)
          }
        })
      }
    }
  }
}

test("push-up hit testing uses only the remaining rows, with margins, and never selects the overlay", () => {
  const e = env(60, true)
  const pane = new TranscriptPane()
  const older = prompt("Older\nSecond\nThird")
  const newer = prompt("Newer")
  for (const block of [older, output("older", 12), newer, output("newer", 30)]) pane.add(block)
  let pinned = older
  let visibleRows = 0
  const render = () =>
    pane.render(e, 16, (layout) => {
      const overlay = stickyPromptOverlay(pane.blocks, layout, e, 16)
      pinned = overlay.block!
      visibleRows = overlay.lines.length
      return overlay.lines
    })
  render()
  pane.toBlock(newer)
  pane.scrollBy(-1)
  render()
  expect(visibleRows).toBe(1)
  const terminal = new FakeTerminal(66, 24)
  const mouse = createMouse({
    pane,
    paneTop: () => 3,
    paneLeft: () => 3,
    paneWidth: () => 60,
    paneRows: () => 16,
    stickyRows: () => visibleRows,
    stickyPrompt: () => pinned,
    requestRender: () => {},
    showNote: () => {},
    terminal,
  })
  mouse.mouse(event("press", 3, 2)) // Outside the content margin: no jump.
  render()
  expect(visibleRows).toBe(1)
  mouse.mouse(event("press", 4, 5)) // New real band's top padding: outside the old overlay.
  expect(pane.dragging).toBe(true)
  mouse.stopDrag()
  mouse.mouse(event("press", 3, 5))
  mouse.mouse(event("release", 3, 5))
  render()
  expect(pane.layout[0]).toEqual({ block: older, line: 0 })
  expect(pane.selectedText()).toBe("")
  expect(terminal.output).not.toContain("\x1b]52;")
  pane.follow()
  render()
  mouse.mouse(event("press", 3 + visibleRows + 1, 5))
  mouse.mouse(event("drag", 3, 5))
  mouse.mouse(event("release", 3, 5))
  expect(pane.selectedText()).not.toContain("Newer")
  expect(pane.selectedText()).not.toContain("Older")
  expect(pane.selectedText()).toContain("newer")
  mouse.stopEdgeScroll()
})

test("history ends stickiness with the same row-by-row clipping as a new turn", () => {
  const e = env(60, true)
  const pane = new TranscriptPane()
  const older = prompt("Older\nSecond\nThird")
  const history = new LinesBlock("history", () => ["History boundary"])
  for (const block of [older, output("old", 20), history, output("history", 30)]) pane.add(block)
  pane.render(e, 16)
  pane.toBlock(history)
  pane.scrollBy(-5)
  for (let distance = 5; distance >= 0; distance--) {
    pane.render(e, 16)
    const overlay = stickyPromptOverlay(pane.blocks, pane.layout, e, 16)
    expect(overlay.lines).toHaveLength(distance)
    expect(overlay.block).toBe(distance ? older : undefined)
    pane.scrollBy(1)
  }
})

test("resize while pinned keeps the anchor, constant height, and newly wrapped ANSI band", () => {
  const pane = new TranscriptPane()
  const block = prompt("Long words that wrap differently at thirty cells and sixty cells\nAnother line")
  const reply = output("reply", 60)
  pane.add(block)
  pane.add(reply)
  const draw = (width: number, height: number) => {
    const e = env(width, true)
    return pane.render(e, height, (layout) => stickyPromptOverlay(pane.blocks, layout, e, height).lines)
  }
  draw(60, 16)
  pane.scrollBy(-10)
  const anchor = pane.layout[0]
  draw(60, 16)
  const pinnedAnchor = pane.layout[0]
  expect(pinnedAnchor).not.toEqual(anchor)
  for (const [width, height] of [
    [30, 18],
    [100, 8],
    [60, 16],
  ]) {
    expect(draw(width!, height!)).toHaveLength(height!)
    expect(pane.layout[0]).toEqual(pinnedAnchor)
  }
})

for (const protocol of ["sixel", "kitty", "iterm2"] as const) {
  test(`${protocol} image placements never paint over the sticky overlay`, async () => {
    const fit = { width: 40, height: 160, cols: 4, rows: 8 }
    const image = new ScreenImage(protocol, fit, 20, async () =>
      fakePayload({ protocol, fit, cellHeight: 20, whole: false }),
    )
    await new Promise<void>((resolve) => image.whenReady(resolve))
    expect(image.ready).toBe(true)
    const rows = Array<string>(8).fill("")
    setImagesIn(rows, [{ line: 0, col: 2, image, alt: "image alt" }])
    const picture = new LinesBlock("assistant", () => rows)
    const pane = new TranscriptPane()
    pane.add(prompt("One\nTwo\nThree"))
    pane.add(picture)
    pane.add(output("tail", 30))
    const store = new ImageStore({
      support: { protocol, cell: { width: 10, height: 20 } },
      cwd: ".",
      maxRows: () => 16,
      open: async () => undefined,
    })
    const e = { ...env(60, true), images: { store, changed: () => {} } }
    const render = () => pane.render(e, 16, (layout) => stickyPromptOverlay(pane.blocks, layout, e, 16).lines)
    render()
    pane.toBlock(picture)
    const frame = render()
    if (protocol === "iterm2") {
      expect(pane.placements).toEqual([])
      expect(frame[5]).toBe(`  image alt${e.theme.muted(" (scroll to view)")}`)
    } else {
      expect(pane.placements).toEqual([{ image, row: 5, col: 2, from: 5, to: 8, key: `${picture.id}:0` }])
    }
    // Covered images are not drawn at all, even with crop support.
    pane.scrollBy(3)
    render()
    expect(pane.placements).toEqual([])
    image.release()
  })
}

test("resizing the overlay viewport to an exact tail fit resumes follow mode", () => {
  const e = env(60, true)
  const pane = new TranscriptPane()
  pane.add(prompt("One\nTwo\nThree"))
  pane.add(output("tail", 30))
  const draw = (height: number) =>
    pane.render(e, height, (layout) => stickyPromptOverlay(pane.blocks, layout, e, height).lines)
  draw(16)
  pane.scrollBy(-1)
  draw(16)
  expect(pane.following).toBe(false)
  expect(pane.rowsBelow).toBe(1)
  draw(17)
  expect(pane.following).toBe(true)
  expect(pane.rowsBelow).toBe(0)
  pane.add(output("new tail", 3))
  expect(draw(17).at(-1)).toBe("  new tail 2")
})
