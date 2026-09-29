import { expect, test } from "bun:test"
import { stripAnsi } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { Block, type BlockEnv, foldMarkdown, ReplyBlock } from "../src/blocks.ts"
import type { BlockKind } from "../src/transcript.ts"
import { highlight, TranscriptPane } from "../src/transcript-pane.ts"

/** A block of fixed lines that counts how often it is drawn. */
class Counted extends Block {
  draws = 0
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

test("a changed width draws blocks again at that width; the cache keeps both while selected", () => {
  const { pane: p, all } = pane(3, 2)
  p.render(env(80), 10)
  const draws = all[2]!.draws
  p.render(env(4), 10)
  expect(all[2]!.draws).toBe(draws + 1)
  expect(p.render(env(4), 2)).toEqual(["b2 l", "b2 l"])
})

test("selecting moves over blocks, marks the selected one and scrolls it into view", () => {
  const { pane: p, all } = pane(10, 3)
  p.render(env(), 4)
  p.selectPrev()
  expect(p.selected).toBe(all[9])
  expect(p.render(env(), 4).slice(-3)).toEqual(["▌b9 l0", "▌b9 l1", "▌b9 l2"])
  for (let i = 0; i < 5; i++) p.selectPrev()
  expect(p.selected).toBe(all[4])
  expect(p.render(env(), 4)).toContain("▌b4 l0")
  p.selectNext()
  expect(p.selected).toBe(all[5])
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
  // Streaming a reply: one frame per token, nothing else drawn again.
  const reply = new ReplyBlock("", true, false)
  p.add(reply)
  const before = all.reduce((n, b) => n + b.draws, 0)
  const frames: number[] = []
  for (let i = 0; i < 2000; i++) {
    reply.append(i % 20 === 19 ? "word\n\n" : "word ")
    p.changed()
    frames.push(time(() => p.render(e, 40)))
  }
  expect(all.reduce((n, b) => n + b.draws, 0) - before).toBeLessThanOrEqual(2)
  reply.finish()
  // Paging up through a thousand pages and back to the end.
  const paging: number[] = []
  for (let i = 0; i < 1000; i++) {
    p.pageUp()
    paging.push(time(() => p.render(e, 40)))
  }
  const top = time(() => {
    p.toTop()
    p.render(e, 40)
  })
  const end = time(() => {
    p.follow()
    p.render(e, 40)
  })
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const sorted = [...frames].sort((a, b) => a - b)
  const stats = {
    firstFrameMs: first.toFixed(2),
    streamFrameAvgMs: avg(frames).toFixed(3),
    streamFrameP99Ms: sorted[Math.floor(sorted.length * 0.99)]!.toFixed(3),
    pageFrameAvgMs: avg(paging).toFixed(3),
    homeMs: top.toFixed(2),
    endMs: end.toFixed(2),
  }
  console.log("transcript pane, 5000 blocks / 200k lines:", stats)
  // Generous bounds for slow CI machines; a frame is 16 ms.
  expect(avg(frames)).toBeLessThan(5)
  expect(avg(paging)).toBeLessThan(5)
  // Find reads every block once, then works from the cache.
  const find = time(() => p.find("l39"))
  expect(p.matchCount).toBe(5000)
  console.log("find over 200k lines:", `${find.toFixed(1)} ms`)
  expect(find).toBeLessThan(3000)
})
