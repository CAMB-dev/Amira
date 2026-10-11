import { expect, spyOn, test } from "bun:test"
import { plain } from "../../tui-kit/test/context.ts"
import { type BlockEnv, ReasoningBlock } from "../src/blocks.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const at = new Date(2026, 9, 10, 20, 19).getTime()
const env = (width = 80, detail: BlockEnv["detail"] = "summary"): BlockEnv => ({
  theme: plain.theme,
  width,
  detail,
  reasoningExpandKey: "ctrl+o",
  now: at,
  spinner: "*",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
})

test("collapsed reasoning reuses cached rows on deltas that only change hidden text", () => {
  const pane = new TranscriptPane()
  const block = new ReasoningBlock("First", undefined, at, true)
  const render = spyOn(block, "lines")
  pane.add(block)
  const rows = pane.plain(block, env())
  const revision = block.version
  for (let i = 0; i < 100; i++) block.append(" next")
  expect(block.version).toBe(revision)
  expect(pane.plain(block, env())).toBe(rows)
  expect(render).toHaveBeenCalledTimes(1)
  block.finish(at + 4200)
  expect(pane.plain(block, env())[0]).toContain("Thought for 4.2s")
  expect(render).toHaveBeenCalledTimes(2)
})

test("the disclosure becoming available invalidates a collapsed head once", () => {
  const pane = new TranscriptPane()
  const block = new ReasoningBlock("", undefined, at, true)
  pane.add(block)
  expect(pane.plain(block, env())[0]).not.toContain("ctrl+o")
  block.append(" \n")
  expect(block.version).toBe(0)
  block.append("A thought.")
  expect(block.version).toBe(1)
  expect(pane.plain(block, env())[0]).toContain("ctrl+o to expand")
  block.append(" More.")
  expect(block.version).toBe(1)
})

test("full-detail caches at another width refresh without invalidating collapsed rows", () => {
  const pane = new TranscriptPane()
  const block = new ReasoningBlock("First", undefined, undefined, true)
  pane.add(block)
  expect(pane.plain(block, env(40, "full"))).toContain("    First")
  const collapsed = pane.plain(block, env())
  block.append(" second")
  expect(pane.plain(block, env())).toBe(collapsed)
  expect(pane.plain(block, env(40, "full"))).toContain("    First second")
  block.expanded = true
  expect(pane.plain(block, env())).toContain("    First second")
  block.append(" third")
  expect(pane.plain(block, env())).toContain("    First second third")
})

test("visible reasoning deltas refresh find and invalidate selections without touching collapsed versions", () => {
  const pane = new TranscriptPane()
  const block = new ReasoningBlock("First", undefined, undefined, true)
  block.expanded = true
  pane.add(block)
  pane.render(env(), 6)
  pane.find("needle")
  expect(pane.matchCount).toBe(0)
  pane.selectText({ block, line: 1, col: 4 }, { block, line: 1, col: Number.POSITIVE_INFINITY })
  expect(pane.selectedText()).toBe("First")
  const revision = block.version
  block.append(" needle")
  pane.changed()
  pane.render(env(), 6)
  expect(block.version).toBe(revision)
  expect(pane.matchCount).toBe(1)
  expect(pane.selectedText()).toBe("")
})
