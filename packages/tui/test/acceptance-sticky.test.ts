import { expect, test } from "bun:test"
import { defaultTheme, stripAnsi, surfaceTheme } from "@amira/tui-kit"
import { type BlockEnv, LinesBlock, ReplyBlock, userBlock } from "../src/blocks.ts"
import { userBandPaddingIn } from "../src/format.ts"
import { stickyPromptOverlay } from "../src/pane/sticky-prompt.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"
import { paste, setup, waitFor } from "./app-harness.ts"

const env: BlockEnv = {
  theme: { ...defaultTheme, ...surfaceTheme("dark") },
  width: 60,
  now: 0,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
}
const prompt = (text: string) => userBlock({ role: "user", content: [{ type: "text", text }] })
const output = (text: string, count: number) =>
  new LinesBlock("assistant", () => Array.from({ length: count }, (_, i) => `  ${text} ${i}`))

for (const action of ["selectPrev", "reveal"] as const) {
  test(`${action} reveals a block below the sticky overlay, not merely in underlying layout`, () => {
    const pane = new TranscriptPane()
    const target = output("target", 1)
    const tail = output("tail", 40)
    for (const block of [prompt("One\nTwo\nThree"), output("before", 20), target, tail]) pane.add(block)
    let covered = 0
    const render = () =>
      pane.render(env, 16, (layout) => {
        const overlay = stickyPromptOverlay(pane.blocks, layout, env, 16)
        covered = overlay.lines.length
        return overlay.lines
      })
    render()
    pane.toBlock(target)
    render()
    expect(covered).toBe(5)
    expect(pane.layout[0]).toEqual({ block: target, line: 0 })
    if (action === "selectPrev") {
      pane.select(tail)
      pane.selectPrev()
      expect(pane.selected).toBe(target)
    } else pane.reveal(target)
    const frame = render()
    const row = pane.layout.findIndex((r) => r.block === target && r.line === 0)
    expect(row).toBeGreaterThanOrEqual(covered)
    expect(stripAnsi(frame[row]!)).toContain("target 0")
    if (action === "selectPrev") expect(stripAnsi(frame[row]!)).toStartWith("▌")
    // Revealing an older target changes the overlay from a short band to a taller one.
    const newest = output("newest", 40)
    pane.add(prompt("Newer"))
    pane.add(newest)
    pane.toBlock(newest)
    pane.scrollBy(10)
    render()
    expect(covered).toBe(3)
    pane.reveal(target)
    render()
    expect(covered).toBe(5)
    expect(pane.layout.findIndex((r) => r.block === target && r.line === 0)).toBe(covered)
  })
}

test("keyboard code selection reveals the entire frame below the recomputed overlay", () => {
  const pane = new TranscriptPane()
  const reply = new ReplyBlock(
    `\`\`\`ts\nconst answer = 42\n\`\`\`\n\n${"Body\n\n".repeat(20)}`,
    false,
    false,
  )
  for (const block of [prompt("Older\nSecond\nThird"), output("before", 20), prompt("Newer"), reply])
    pane.add(block)
  let covered = 0
  const render = () =>
    pane.render(env, 16, (layout) => {
      const overlay = stickyPromptOverlay(pane.blocks, layout, env, 16)
      covered = overlay.lines.length
      return overlay.lines
    })
  render()
  pane.toBlock(reply)
  render()
  pane.select(reply)
  const code = pane.codeBlocks(reply)[0]!
  expect(code).toBeDefined()
  expect(pane.selectCode(0)).toBe(true)
  const frame = render()
  expect(covered).toBe(3)
  const top = pane.layout.findIndex((r) => r.block === reply && r.line === code.top)
  const bottom = pane.layout.findIndex((r) => r.block === reply && r.line === code.bottom)
  expect(top).toBeGreaterThanOrEqual(covered)
  expect(bottom).toBeGreaterThanOrEqual(top)
  expect(stripAnsi(frame.join("\n"))).toContain("const answer = 42")
})

const ESC = "\x1b[27u"
const SELECT = "\x1b[1;5A"
const SHIFT_DOWN = "\x1b[1;2B"

for (const cols of [50, 80, 120]) {
  for (const margin of [0, 3]) {
    for (const mode of ["fullscreen"] as const) {
      test(`keyboard reveal ignores uncovered user-band padding: ${mode} ${cols}/${margin}`, async () => {
        const app = await setup([{ text: "reply tail\n".repeat(50) }], {
          cols,
          rows: 32,
          theme: env.theme,
          settings: { mode, margin, marginRows: 0 },
        })
        const prefix = " ".repeat(cols < 60 ? 0 : margin)
        try {
          app.terminal.send(`${paste("One\nTwo\nThree\nFour")}\r`)
          await app.idle()
          expect(app.screen.inAltScreen).toBe(mode === "fullscreen")
          expect(app.terminal.output).toContain("\x1b[48;2;")

          // Select the reply, then the prompt: its natural entry includes all four text rows.
          app.terminal.send(SELECT)
          await waitFor(() => /› reply \d+ of/.test(app.live()), "selected reply")
          app.terminal.send(SELECT)
          await waitFor(() => /› message \d+ of/.test(app.live()), "selected prompt")
          expect(app.screen.lines[6]).toBe(`${prefix}▌ Four`)

          // One row past natural entry, the capped sticky preview covers every real text row.
          // Only the actual band's bottom padding remains uncovered at viewport row four.
          app.terminal.send(ESC + SHIFT_DOWN)
          await Bun.sleep(40)
          expect(app.screen.lines[2]).toBe("")
          expect(app.screen.lines[3]).toStartWith(`${prefix}› One`)
          expect(app.screen.lines[4]).toBe(`${prefix}  Two`)
          expect(app.screen.lines[5]).toBe(`${prefix}  Three`)
          expect(app.screen.lines[6]).toBe("")
          expect(app.live()).not.toContain("Four")

          app.terminal.send(SELECT)
          await waitFor(() => /› reply \d+ of/.test(app.live()), "reselected reply")
          app.terminal.clearWrites()
          app.terminal.send(SELECT)
          await waitFor(() => /› message \d+ of/.test(app.live()), "reselected prompt")
          // A selection status alone is not enough: the real prompt must be exposed and marked.
          expect(app.screen.lines[6]).toBe(`${prefix}▌ Four`)
          expect(app.screen.lines[3]).toStartWith(`${prefix}› One`)
          expect(app.screen.lines[4]).toBe(`${prefix}▌ Two`)
          expect(app.screen.lines[5]).toBe(`${prefix}▌ Three`)
          expect(app.terminal.output).toContain("\x1b[7m›")
          for (const word of ["One", "Two", "Three", "Four"])
            expect(app.screen.lines.filter((row) => row.includes(word))).toHaveLength(1)
        } finally {
          app.terminal.send(`${ESC}${ESC}\x03\x03`)
          expect(await app.exited).toBe(0)
        }
      })
    }
  }
}

for (const banded of [false, true]) {
  for (const text of ["Incoming", "Incoming\nSecond\nThird"]) {
    test(`compact natural entry and forward/reverse handover preserve actual prompt rows: banded ${banded}, ${text}`, () => {
      const e = { ...env, theme: banded ? env.theme : defaultTheme }
      const pane = new TranscriptPane()
      const incoming = prompt(text)
      for (const block of [
        prompt("Older\nSecond\nThird"),
        output("before", 20),
        incoming,
        output("tail", 30),
      ])
        pane.add(block)
      const render = () => pane.render(e, 8, (layout) => stickyPromptOverlay(pane.blocks, layout, e, 8).lines)
      render()
      pane.toBlock(incoming)
      const real = pane.render(e, 8)
      expect(render()).toEqual(real)
      const padding = userBandPaddingIn(pane.lines(incoming, e))
      const frames: string[][] = []
      pane.scrollBy(-2)
      for (let step = -2; step <= padding + 2; step++) {
        if (step > -2) pane.scrollBy(1)
        const frame = render()
        expect(frame.filter((row) => stripAnsi(row).includes("Incoming"))).toHaveLength(1)
        frames.push(frame)
      }
      for (let i = frames.length - 2; i >= 0; i--) {
        pane.scrollBy(-1)
        expect(render()).toEqual(frames[i]!)
      }
    })
  }
}
