import { expect, test } from "bun:test"
import { markdownStyles, parseInline } from "../src/markdown/inline.ts"
import { defaultTheme } from "../src/style.ts"

const options = { styles: markdownStyles(defaultTheme), hyperlinks: "web" as const }
const unsafe = [
  "vscode://file/C:/Windows/win.ini",
  "vscode-insiders://file/etc/passwd",
  "file:///etc/passwd",
  "mailto:local@example.invalid",
  "javascript:alert",
  "data:text/plain;base64,QQ==",
  "ftp://example.invalid/a",
  "//example.invalid/a",
  "#section",
  "./remote.ts",
  "C:/Windows/win.ini",
]

for (const target of unsafe)
  test(`web-only links keep ${target} inert for text, images and references`, () => {
    for (const source of [
      `[remote source](${target})`,
      `![remote source](${target})`,
      "[remote source][r]",
      "![remote source][r]",
    ]) {
      const runs = parseInline(source, { ...options, refs: new Map([["r", { url: target }]]) })
      expect(
        runs.flatMap((run) => (run.link ? [run.link] : [])),
        source,
      ).toEqual([])
    }
  })

test("web-only policy retains HTTP(S) and local mode still supports explicit editor links", () => {
  for (const target of ["https://example.invalid/path", "http://example.invalid/path"]) {
    for (const source of [`[source](${target})`, `![source](${target})`, "[source][r]", "![source][r]"])
      expect(
        parseInline(source, { ...options, refs: new Map([["r", { url: target }]]) }).some(
          (run) => run.link === target,
        ),
      ).toBe(true)
  }
  expect(
    parseInline("[source](vscode://file/C:/Windows/win.ini)", { ...options, hyperlinks: true }).some((run) =>
      run.link?.startsWith("vscode:"),
    ),
  ).toBe(true)
})
