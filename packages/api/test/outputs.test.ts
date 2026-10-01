import { expect, test } from "bun:test"
import {
  ARTIFACT_HEADER,
  type ArtifactInfo,
  artifactIdOf,
  countLines,
  OMITTED_NOTE,
  outputPreview,
  previewNoteLine,
  tokenWeight,
} from "../src/outputs.ts"

const artifact = (text: string): ArtifactInfo => ({
  id: "a_0123456789",
  path: "/s/x.assets/outputs/a_0123456789.txt",
  tool: "bash",
  sessionId: "s",
  chars: text.length,
  lines: countLines(text),
  bytes: Buffer.byteLength(text),
  complete: true,
  createdAt: "2026-10-01T00:00:00.000Z",
})

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

test("a preview starts with the header, keeps whole lines at both ends and says exactly what it left out", () => {
  const text = numbered(5000)
  const out = outputPreview({ text, artifact: artifact(text), previewChars: 2000 })
  const lines = out.split("\n")
  expect(lines[0]).toMatch(ARTIFACT_HEADER)
  expect(lines[0]).toContain("5,000 lines")
  expect(lines[0]).toContain("/s/x.assets/outputs/a_0123456789.txt")
  expect(lines[1]).toBe("line 1")
  expect(lines.at(-1)).toBe("line 5000")
  expect(out.length).toBeLessThanOrEqual(2000)
  const noteAt = lines.findIndex((l) => OMITTED_NOTE.test(l))
  const [, count, , first, last] = OMITTED_NOTE.exec(lines[noteAt]!)!
  // The note's range is the lines between the head and the tail, and the header points at it.
  expect(lines[noteAt - 1]).toBe(`line ${Number(first) - 1}`)
  expect(lines[noteAt + 1]).toBe(`line ${Number(last) + 1}`)
  expect(Number(count!.replace(/,/g, ""))).toBe(Number(last) - Number(first) + 1)
  expect(lines[0]).toContain(`"offset":${first}`)
  expect(artifactIdOf(out)).toBe("a_0123456789")
})

test("the artifact of a preview is found also after a line a tool puts first", () => {
  const text = numbered(3000)
  const preview = outputPreview({ text, artifact: artifact(text), previewChars: 2000 })
  expect(artifactIdOf(`Shell: Windows PowerShell 5.1\n\n${preview}`)).toBe("a_0123456789")
  expect(artifactIdOf(`one\ntwo\nthree\n${preview}`)).toBeUndefined()
})

test("short text is shown whole under the header; CRLF becomes LF", () => {
  const out = outputPreview({ text: "a\r\nb\r\n", artifact: artifact("a\r\nb\r\n"), previewChars: 8000 })
  expect(out).not.toContain("\r")
  expect(out.split("\n").slice(1)).toEqual(["a", "b", ""])
  expect(OMITTED_NOTE.test(out)).toBe(false)
})

test("one long line is cut by characters, never inside a surrogate pair", () => {
  const emoji = "😀".repeat(5000)
  const out = outputPreview({ text: emoji, artifact: artifact(emoji), previewChars: 2000 })
  // No lone surrogate anywhere.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false)
  expect(out).toContain("omitted")
})

test("CJK text gets a shorter preview, about as many tokens as an ASCII one", () => {
  expect(tokenWeight("plain ascii text")).toBe(1)
  expect(tokenWeight("中文内容测试")).toBe(4)
  expect(tokenWeight("")).toBe(1)
  const cjk = Array.from({ length: 2000 }, (_, i) => `第${i}行：编译模块完成，没有错误`).join("\n")
  const ascii = numbered(4000)
  const a = outputPreview({ text: ascii, artifact: artifact(ascii), previewChars: 8000 })
  const c = outputPreview({ text: cjk, artifact: artifact(cjk), previewChars: 8000 })
  expect(c.length).toBeLessThan(a.length / 2)
  expect(c.split("\n")[1]).toBe("第0行：编译模块完成，没有错误")
})

test("an output that could not be saved says why and names no artifact", () => {
  const text = numbered(3000)
  const out = outputPreview({
    text: text.slice(0, 500),
    saveError: "disk full",
    total: { chars: text.length, lines: 3000 },
    previewChars: 1000,
  })
  expect(out).toStartWith("[Output too long: ")
  expect(out).toContain("3,000 lines")
  expect(out).toContain("disk full")
  expect(out).not.toContain("output_read")
  expect(artifactIdOf(out)).toBeUndefined()
})

test("frontends show a preview's own lines as short muted notes", () => {
  const text = numbered(5000)
  const lines = outputPreview({ text, artifact: artifact(text), previewChars: 2000 }).split("\n")
  expect(previewNoteLine(lines[0]!)).toEqual({
    kind: "muted",
    text: `… output saved as a_0123456789 · 5,000 lines · ${text.length.toLocaleString("en-US")} chars`,
  })
  const note = lines.find((l) => OMITTED_NOTE.test(l))!
  expect(previewNoteLine(note)?.text).toMatch(/^… [\d,]+ lines omitted \(\d+–\d+\)$/)
  expect(previewNoteLine("line 1")).toBeUndefined()
  expect(previewNoteLine("[Output too long: 10 characters, 2 lines. x]")?.kind).toBe("muted")
})
