import { expect, test } from "bun:test"
import { fileDiff, splitLines } from "../src/diff.ts"

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`)

test("splitLines drops line endings and the empty line after a final break", () => {
  expect(splitLines("")).toEqual([])
  expect(splitLines("a\r\nb\n")).toEqual(["a", "b"])
  expect(splitLines("a\n\nb")).toEqual(["a", "", "b"])
})

test("a one-line change is one hunk with two lines of context and its line numbers", () => {
  const before = lines(10).join("\n")
  const after = before.replace("line 5", "line five")
  expect(fileDiff(before, after)).toEqual({
    hunks: [
      {
        oldStart: 3,
        oldLines: 5,
        newStart: 3,
        newLines: 5,
        lines: [" line 3", " line 4", "-line 5", "+line five", " line 6", " line 7"],
      },
    ],
    added: 1,
    removed: 1,
  })
})

test("changes far apart are separate hunks; close ones share one", () => {
  const before = lines(30)
  const far = [...before]
  far[2] = "x"
  far[25] = "y"
  const d = fileDiff(before.join("\n"), far.join("\n"))
  expect(d.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([
    [1, 1],
    [24, 24],
  ])
  const near = [...before]
  near[10] = "x"
  near[14] = "y"
  expect(fileDiff(before.join("\n"), near.join("\n")).hunks).toHaveLength(1)
})

test("insertions and deletions shift the new line numbers", () => {
  const before = lines(8).join("\n")
  const after = [...lines(2), "new a", "new b", ...lines(5, 4)].join("\n")
  const d = fileDiff(before, after)
  expect(d).toMatchObject({ added: 2, removed: 1 })
  expect(d.hunks[0]!.lines).toEqual([
    " line 1",
    " line 2",
    "-line 3",
    "+new a",
    "+new b",
    " line 4",
    " line 5",
  ])
  expect(d.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 6 })
})

test("Myers finds the shortest edit inside a changed region", () => {
  const d = fileDiff(["a", "b", "c", "d", "e"].join("\n"), ["a", "c", "d", "x", "e"].join("\n"), 0)
  expect(d.hunks.flatMap((h) => h.lines)).toEqual(["-b", "+x"])
  expect(d).toMatchObject({ added: 1, removed: 1 })
})

test("a new file is all additions; line endings do not count as changes", () => {
  expect(fileDiff("", "a\nb\n")).toMatchObject({ added: 2, removed: 0 })
  expect(fileDiff("a\r\nb\r\n", "a\nb\n")).toEqual({ hunks: [], added: 0, removed: 0 })
})

test("huge changes keep their counts but only the first hunk lines", () => {
  const before = lines(2000).join("\n")
  const after = lines(2000, 5000).join("\n")
  const d = fileDiff(before, after)
  expect(d).toMatchObject({ added: 2000, removed: 2000, truncated: true })
})
