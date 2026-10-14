import { expect, test } from "bun:test"
import { defaultTheme, ImageStore, stripAnsi, surfaceTheme, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { fakeProvider } from "../../tui-kit/test/fake-images.ts"
import {
  Block,
  type BlockEnv,
  type BlockImages,
  foldMarkdown,
  imagesIn,
  ReplyBlock,
  userBlock,
} from "../src/blocks.ts"
import { localClock, timestampIn } from "../src/format.ts"
import { sliceCells } from "../src/text-selection.ts"
import type { BlockKind } from "../src/transcript.ts"
import { highlight, TranscriptPane } from "../src/transcript-pane.ts"

/** A block of fixed lines that counts how often it is drawn. */
class Counted extends Block {
  draws = 0
  revisions = 0
  searches = 0
  override cacheVersion(env: BlockEnv): number | string {
    this.revisions++
    return super.cacheVersion(env)
  }
  override searchRows(plain: readonly string[], lines: readonly string[]) {
    this.searches++
    return super.searchRows(plain, lines)
  }
  constructor(
    readonly kind: BlockKind,
    private text: string[],
  ) {
    super()
  }
  lines(env: BlockEnv): string[] {
    this.draws++
    return this.text.map((l) => l.slice(0, env.width))
  }
  copyText(): string {
    return this.text.join("\n")
  }
}

const env = (width = 80): BlockEnv => ({
  theme: plain.theme,
  width,
  now: 0,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
})

function pane(blocks: number, lines: number): { pane: TranscriptPane; all: Counted[] } {
  const p = new TranscriptPane()
  const all: Counted[] = []
  for (let b = 0; b < blocks; b++) {
    const block = new Counted(
      b % 2 ? "assistant" : "user",
      Array.from({ length: lines }, (_, l) => `b${b} l${l}`),
    )
    all.push(block)
    p.add(block)
  }
  return { pane: p, all }
}

test("the tail is drawn from the blocks in view only, with a blank row between blocks", () => {
  const { pane: p, all } = pane(10, 3)
  const rows = p.render(env(), 6)
  expect(rows).toEqual(["b8 l1", "b8 l2", "", "b9 l0", "b9 l1", "b9 l2"])
  // Blocks above the view were never drawn.
  expect(all.slice(0, 7).every((b) => b.draws === 0)).toBe(true)
  // Drawn again, nothing is drawn afresh.
  const before = all.map((b) => b.draws)
  p.render(env(), 6)
  expect(all.map((b) => b.draws)).toEqual(before)
})

test("short content sits at the bottom, right above the input", () => {
  const { pane: p } = pane(1, 2)
  expect(p.render(env(), 5)).toEqual(["", "", "", "b0 l0", "b0 l1"])
})

test("scrolling up keeps rows in place while blocks arrive; scrolling to the end follows again", () => {
  const { pane: p } = pane(10, 3)
  p.render(env(), 4)
  p.scrollBy(-5)
  const shown = p.render(env(), 4)
  expect(p.following).toBe(false)
  expect(shown).toEqual(["b7 l2", "", "b8 l0", "b8 l1"])
  p.add(new Counted("user", ["new"]))
  expect(p.unseen).toBe(true)
  expect(p.render(env(), 4)).toEqual(shown)
  p.scrollBy(100)
  expect(p.following).toBe(true)
  expect(p.unseen).toBe(false)
  expect(p.render(env(), 4).at(-1)).toBe("new")
  p.toTop()
  expect(p.render(env(), 4)).toEqual(["b0 l0", "b0 l1", "b0 l2", ""])
  p.pageDown()
  expect(p.render(env(), 4)[0]).toBe("")
})

test("removing the paused separator anchor retains the start of the tall block below it", () => {
  const p = new TranscriptPane()
  const separator = new Counted("notice", ["  ---"])
  const output = new Counted(
    "tool",
    Array.from({ length: 30 }, (_, i) => `out ${i}`),
  )
  p.add(new Counted("assistant", ["reply"]))
  p.add(separator)
  p.add(output)
  p.render(env(), 5)
  p.toBlock(separator)
  expect(p.render(env(), 5)).toEqual(["  ---", "", "out 0", "out 1", "out 2"])
  expect(p.following).toBe(false)
  p.remove(separator)
  const shown = p.render(env(), 5)
  expect(p.following).toBe(false)
  expect(shown).toEqual(["", "out 0", "out 1", "out 2", "out 3"])
  expect(p.layout[0]).toEqual({ block: output, line: -1 })
  p.add(new Counted("tool", ["later output"]))
  expect(p.render(env(), 5)).toEqual(shown)
  expect(p.unseen).toBe(true)
})

test("removing a paused last block anchors the preceding block's final row", () => {
  const p = new TranscriptPane()
  const previous = new Counted("assistant", ["previous 0", "previous 1", "previous 2"])
  const last = new Counted("tool", ["last 0", "last 1", "last 2"])
  p.add(previous)
  p.add(last)
  p.render(env(), 1)
  p.toBlock(last)
  expect(p.render(env(), 1)).toEqual(["last 0"])
  expect(p.following).toBe(false)
  p.remove(last)
  expect(p.render(env(), 1)).toEqual(["previous 2"])
  expect(p.following).toBe(false)
  p.add(new Counted("tool", ["new 0", "new 1"]))
  expect(p.render(env(), 1)).toEqual(["previous 2"])
})

test("removing the only paused block returns to an empty following pane", () => {
  const p = new TranscriptPane()
  const only = new Counted("assistant", ["row 0", "row 1"])
  p.add(only)
  p.render(env(), 1)
  p.toTop()
  expect(p.following).toBe(false)
  p.remove(only)
  expect(p.render(env(), 1)).toEqual([""])
  expect(p.following).toBe(true)
})

test("a changed width draws blocks again at that width; the cache keeps both while selected", () => {
  const { pane: p, all } = pane(3, 2)
  p.render(env(80), 10)
  const draws = all[2]!.draws
  p.render(env(4), 10)
  expect(all[2]!.draws).toBe(draws + 1)
  expect(p.render(env(4), 2)).toEqual(["b2 l", "b2 l"])
})

test("the user's band fills the pane at every width, also while selected", () => {
  const p = new TranscriptPane()
  const user = userBlock({ role: "user", content: [{ type: "text", text: "看看 this test 🧪 please" }] })
  p.add(user)
  const banded = (width: number): BlockEnv => ({
    ...env(width),
    theme: { ...defaultTheme, ...surfaceTheme("light") },
  })
  for (const [width, expected] of [
    [40, ["", "  › 看看 this test 🧪 please", ""]],
    [17, ["", "  › 看看 this", "    test 🧪", "    please", ""]],
    [11, ["", "  › 看看", "    this", "    test", "    🧪", "    pleas", "    e", ""]],
  ] as const) {
    const rows = p.render(banded(width), 8).filter((r) => r !== "")
    expect(rows.map((r) => stripAnsi(r).trimEnd())).toEqual([...expected])
    expect(rows[0]).toBe(`\x1b[48;2;232;230;225m${" ".repeat(width)}\x1b[49m`)
    expect(rows.at(-1)).toBe(rows[0])
    for (const r of rows) {
      expect(r.startsWith("\x1b[48;2;232;230;225m")).toBe(true)
      expect(visibleWidth(r)).toBe(width)
    }
  }
  // Selected, its first column is marked: the text is where it was, the row still ends at the edge.
  const before = p.render(banded(17), 8).map(stripAnsi)
  p.select(user)
  const after = p.render(banded(17), 8)
  for (const r of after.filter((r) => r !== "")) expect(visibleWidth(r)).toBe(17)
  expect(after.map((r) => stripAnsi(r).slice(1))).toEqual(before.map((r) => r.slice(1)))
})

test("selecting moves over blocks, marks the selected one and scrolls it into view", () => {
  const { pane: p, all } = pane(10, 3)
  p.render(env(), 4)
  p.selectPrev()
  expect(p.selected).toBe(all[9])
  // A character in the first column shows in inverse video.
  const mark = (row: string) => `\x1b[7m${row[0]}\x1b[27m${row.slice(1)}`
  expect(p.render(env(), 4).slice(-3)).toEqual([mark("b9 l0"), mark("b9 l1"), mark("b9 l2")])
  for (let i = 0; i < 5; i++) p.selectPrev()
  expect(p.selected).toBe(all[4])
  expect(p.render(env(), 4)).toContain(mark("b4 l0"))
  p.selectNext()
  expect(p.selected).toBe(all[5])
})

test("a selected block keeps its width: a blank first column shows the bar", () => {
  const p = new TranscriptPane()
  const reply = new ReplyBlock("a long line of words that wraps at this width", false, false)
  p.add(reply)
  const before = p.render(env(20), 6)
  p.select(reply)
  const after = p.render(env(20), 6)
  expect(after.map((r) => r.slice(1))).toEqual(before.map((r) => r.slice(1)))
  for (const r of after.filter((r) => r !== "")) expect(r.startsWith("▌")).toBe(true)
})

test("a block partly in view is selected where it is: the view does not jump to its top", () => {
  const p = new TranscriptPane()
  p.add(new Counted("user", ["first"]))
  const long = new Counted(
    "assistant",
    Array.from({ length: 20 }, (_, i) => `row ${i}`),
  )
  p.add(long)
  const before = p.render(env(), 5)
  p.selectPrev()
  expect(p.selected).toBe(long)
  expect(p.following).toBe(true)
  expect(
    p
      .render(env(), 5)
      .map(stripAnsi)
      .map((r) => r.slice(1)),
  ).toEqual(before.map((r) => r.slice(1)))
})

test("rows below the view are counted once scrolled up", () => {
  const { pane: p } = pane(4, 3)
  p.render(env(), 4)
  expect(p.rowsBelow).toBe(0)
  p.scrollBy(-5)
  p.render(env(), 4)
  expect(p.rowsBelow).toBe(5)
})

test("find matches text that wraps over rows, and so at any width", () => {
  const p = new TranscriptPane()
  p.add(new ReplyBlock("the quick brown fox jumps over the lazy dog", false, false))
  p.add(new Counted("user", ["quick", "brown"]))
  for (const width of [80, 14, 9]) {
    p.render(env(width), 10)
    p.find("brown fox jumps")
    expect(p.matchCount).toBe(1)
    const rows = p.render(env(width), 10).join("\n")
    // Every segment is marked, the current match underlined.
    expect(rows).toContain("\x1b[7;4m")
    expect(stripAnsi(rows)).toContain("fox")
  }
  // Separate lines of one block join like wrapped ones; blank rows do not.
  p.find("quick brown")
  expect(p.matchCount).toBe(2)
})

for (const kind of ["assistant", "user"] as const) {
  for (const source of [
    "alpha beta gamma delta epsilon zeta",
    "看看 🧪 alpha beta gamma delta epsilon zeta",
  ]) {
    test(`find excludes ${kind} timestamps while preserving wrapped phrase highlights: ${source}`, () => {
      const p = new TranscriptPane()
      const at = new Date(2026, 9, 10, 20, 0).getTime()
      const block =
        kind === "assistant"
          ? new ReplyBlock(source, false, false, at)
          : userBlock({ role: "user", content: [{ type: "text", text: source }] }, at)
      p.add(block)
      const e = {
        ...env(source.startsWith("看看") ? 40 : 30),
        // The user's actual band has padding, so its stamp is not on row zero.
        theme: kind === "user" ? { ...defaultTheme, ...surfaceTheme("light") } : plain.theme,
      }
      p.render(e, 10)
      const lines = p.lines(block, e)
      const stamp = timestampIn(lines)!
      expect(stamp).toBeDefined()
      const first = sliceCells(stripAnsi(lines[stamp.line]!), 0, stamp.to).trimEnd()
      const lastWord = first.split(" ").at(-1)!
      const nextWord = stripAnsi(lines[stamp.line + 1]!)
        .trim()
        .split(" ")[0]!
      p.find(`${lastWord} ${nextWord}`)
      expect(p.matchCount).toBe(1)
      const highlighted = p.render(e, 10)
      const firstMarked = highlighted.find((row) => stripAnsi(row) === stripAnsi(lines[stamp.line]!))!
      expect(firstMarked).toContain(`\x1b[7;4m${lastWord}\x1b[27;24m`)
      expect(stripAnsi(firstMarked.slice(0, firstMarked.indexOf("\x1b[7;4m")))).toBe(
        first.slice(0, first.length - lastWord.length),
      )
      expect(highlighted.some((row) => row.includes(`\x1b[7;4m${nextWord}\x1b[27;24m`))).toBe(true)
      for (const query of [localClock(at), `${lastWord} ${localClock(at)}`]) {
        p.find(query)
        expect(p.matchCount).toBe(0)
      }
    })
  }
}

test("find matches CJK text that wraps between characters, with no space put in", () => {
  const p = new TranscriptPane()
  p.add(new ReplyBlock("这是一个很长的中文句子需要换行显示", false, false))
  for (const width of [80, 12, 9]) {
    p.render(env(width), 10)
    p.find("中文句子需要换行")
    expect(p.matchCount).toBe(1)
  }
})

test("find follows the transcript as blocks come and a reply streams", () => {
  const p = new TranscriptPane()
  p.add(new Counted("user", ["needle"]))
  p.render(env(), 10)
  p.find("needle")
  expect(p.matchCount).toBe(1)
  p.add(new Counted("user", ["another needle"]))
  p.render(env(), 10)
  expect(p.matchCount).toBe(2)
  const reply = new ReplyBlock("", true, false)
  p.add(reply)
  reply.append("a needle streams in")
  const at = Date.now
  try {
    Date.now = () => at() + 1000
    p.render(env(), 10)
  } finally {
    Date.now = at
  }
  expect(p.matchCount).toBe(3)
})

test("find matches ignore case unless the query has capitals, and move from the newest", () => {
  const p = new TranscriptPane()
  for (const t of ["alpha Beta", "beta gamma", "delta", "BETA"]) p.add(new Counted("user", [t]))
  p.render(env(), 3)
  p.find("beta")
  expect(p.matchCount).toBe(3)
  expect(p.matchPosition).toBe(3)
  p.stepMatch(-1)
  expect(p.matchPosition).toBe(2)
  p.stepMatch(1)
  p.stepMatch(1)
  expect(p.matchPosition).toBe(1)
  p.find("BETA")
  expect(p.matchCount).toBe(1)
  const rows = p.render(env(), 3)
  expect(rows.join("\n")).toContain("\x1b[7;4mBETA\x1b[27;24m")
})

test("highlight keeps escape sequences and marks ranges of the plain text", () => {
  const line = "ab\x1b[31mcd\x1b[0mef"
  const out = highlight(line, [{ col: 1, len: 3, current: false }])
  expect(stripAnsi(out)).toBe("abcdef")
  expect(out).toBe("a\x1b[7mb\x1b[31m\x1b[7mcd\x1b[27;24m\x1b[0mef")
})

test("folding a reply cuts long code blocks and hides details bodies", () => {
  const code = Array.from({ length: 20 }, (_, i) => `x${i}`).join("\n")
  const src = `Intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\n<details>\n<summary>Why</summary>\n\nbecause\n</details>\n\nEnd`
  const open = foldMarkdown(src, false)
  expect(open.foldable).toBe(true)
  expect(open.text).toContain("x19")
  expect(open.text).toContain("**▾ Why**")
  expect(open.text).toContain("because")
  const folded = foldMarkdown(src, true).text
  expect(folded).toContain("x5\n… 14 more lines\n```")
  expect(folded).not.toContain("x6")
  expect(folded).toContain("**▸ Why**")
  expect(folded).not.toContain("because")
  expect(folded).toContain("End")
  expect(foldMarkdown("just text\n```\nshort\n```", true).foldable).toBe(false)
})

test("a streaming reply is drawn from what arrived; a width change starts it over from the source", () => {
  const reply = new ReplyBlock("", true, false)
  reply.append("Hello **wor")
  expect(reply.lines(env()).map(stripAnsi)).toEqual(["  Hello **wor"])
  reply.append("ld**\n\nnext")
  expect(reply.lines(env()).map(stripAnsi)).toEqual(["  Hello world", "", "  next"])
  expect(reply.lines(env(9)).map(stripAnsi)).toEqual(["  Hello", "  world", "", "  next"])
  reply.finish()
  expect(reply.live).toBe(false)
  expect(reply.copyText()).toBe("Hello **world**\n\nnext")
})

/**
 * 5000 blocks of 40 lines (200k lines): a frame costs what is in view, streaming does no work
 * on the rest, and scrolling across the conversation stays fast.
 */
test("performance: long sessions scroll and stream with per-frame cost bounded by the view", () => {
  const { pane: p, all } = pane(5000, 40)
  const e = env()
  const time = (fn: () => void) => {
    const t = performance.now()
    fn()
    return performance.now() - t
  }
  // The first frame draws only the last blocks.
  const first = time(() => p.render(e, 40))
  expect(all.reduce((n, b) => n + b.draws, 0)).toBeLessThanOrEqual(3)
  expect(all.reduce((n, b) => n + b.revisions, 0)).toBeLessThanOrEqual(200)
  // Streaming a reply: one frame per token, nothing else drawn again.
  const reply = new ReplyBlock("", true, false)
  p.add(reply)
  const before = all.reduce((n, b) => n + b.draws, 0)
  const revisionsBefore = all.reduce((n, b) => n + b.revisions, 0)
  const frames: number[] = []
  for (let i = 0; i < 2000; i++) {
    reply.append(i % 20 === 19 ? "word\n\n" : "word ")
    p.changed()
    frames.push(time(() => p.render(e, 40)))
  }
  expect(all.reduce((n, b) => n + b.draws, 0) - before).toBeLessThanOrEqual(2)
  // Cached history must not be visited once per token, either.
  expect(all.reduce((n, b) => n + b.revisions, 0) - revisionsBefore).toBeLessThanOrEqual(200 * frames.length)
  reply.finish()
  // Paging up through a thousand pages and back to the end.
  const paging: number[] = []
  const pagingRevisions = all.reduce((n, b) => n + b.revisions, 0)
  const pagingDraws = all.reduce((n, b) => n + b.draws, 0)
  for (let i = 0; i < 1000; i++) {
    p.pageUp()
    paging.push(time(() => p.render(e, 40)))
  }
  expect(all.reduce((n, b) => n + b.revisions, 0) - pagingRevisions).toBeLessThanOrEqual(200 * paging.length)
  expect(all.reduce((n, b) => n + b.draws, 0) - pagingDraws).toBeLessThanOrEqual(3 * paging.length)
  const top = time(() => {
    p.toTop()
    p.render(e, 40)
  })
  const end = time(() => {
    p.follow()
    p.render(e, 40)
  })
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const sorted = [...frames].sort((a, b) => a - b)
  const stats = {
    firstFrameMs: first.toFixed(2),
    streamFrameMedianMs: median(frames).toFixed(3),
    streamFrameP99Ms: sorted[Math.floor(sorted.length * 0.99)]!.toFixed(3),
    pageFrameMedianMs: median(paging).toFixed(3),
    homeMs: top.toFixed(2),
    endMs: end.toFixed(2),
  }
  console.log("transcript pane, 5000 blocks / 200k lines:", stats)
  // Warmed medians reject isolated scheduler pauses without relaxing the frame budget.
  expect(median(frames)).toBeLessThan(5)
  expect(median(paging)).toBeLessThan(5)
  // Find reads every block once per new query. Warm the full search, then change the
  // query each sample so the measurement never substitutes a cache hit for a scan.
  p.find("l38")
  expect(all.every((b) => b.draws === 1 && b.searches === 1)).toBe(true)
  const finds: number[] = []
  for (const query of ["l39", "l38", "l39"]) {
    finds.push(time(() => p.find(query)))
    expect(p.matchCount).toBe(5000)
  }
  const find = median(finds)
  expect(all.every((b) => b.draws === 1 && b.searches === 4)).toBe(true)
  console.log("find over 200k lines, warmed median:", `${find.toFixed(1)} ms`)
  expect(find).toBeLessThan(3000)
  // Found again as the transcript grows: no old block is redrawn OR searched again.
  // Measuring several independent arrivals avoids a single descheduled frame verdict.
  const drawn = all.reduce((n, b) => n + b.draws, 0)
  const arrivals: Counted[] = []
  const incremental: number[] = []
  for (let i = 0; i < 7; i++) {
    const block = new Counted("assistant", ["l39 once more"])
    arrivals.push(block)
    p.add(block)
    incremental.push(time(() => p.render(e, 40)))
    expect(p.matchCount).toBe(5001 + i)
    expect(all.every((b) => b.searches === 4)).toBe(true)
    expect(arrivals.every((b) => b.searches === 1)).toBe(true)
  }
  expect(all.reduce((n, b) => n + b.draws, 0)).toBe(drawn)
  const again = median(incremental)
  console.log("find again after a block came, median:", `${again.toFixed(1)} ms`)
  expect(again).toBeLessThan(Math.max(50, find / 2))
  expect(again).toBeLessThan(1000)
})

test("a streaming reply folded and unfolded lays its image out again", async () => {
  // 30×40 pixels: 3 columns and 2 rows of 10×20 cells.
  const store = new ImageStore({
    support: { protocol: "sixel", cell: { width: 10, height: 20 } },
    cwd: ".",
    open: fakeProvider().open,
    maxRows: () => 20,
  })
  const images: BlockImages = { store, changed: () => {} }
  const e = { ...env(), images }
  const reply = new ReplyBlock("hi\n\n![chart](https://img.test/c-30x40.png)\n\nmore", true, false)
  reply.lines(e)
  const source = store.screen({ url: "https://img.test/c-30x40.png" })
  for (let i = 0; i < 200 && source.state === "loading"; i++) await Bun.sleep(5)
  const shown = () => imagesIn(reply.lines(e))
  expect(shown()).toEqual([expect.objectContaining({ line: 2, col: 2 })])
  reply.toggleFold()
  expect(shown()).toBeUndefined()
  expect(reply.lines(e).map(stripAnsi)).toContain("  🖼️ chart (https://img.test/c-30x40.png)")
  reply.toggleFold()
  expect(shown()).toEqual([expect.objectContaining({ line: 2, col: 2 })])
})
