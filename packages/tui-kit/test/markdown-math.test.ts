import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import {
  type MarkdownNodeRef,
  type MarkdownNodes,
  MarkdownStream,
  renderMarkdown,
} from "../src/components/markdown-stream.ts"
import { inlineMathAt, mathSources } from "../src/markdown/math-source.ts"
import { defaultTheme } from "../src/style.ts"
import { visibleWidth } from "../src/width.ts"
import { plain } from "./context.ts"

type MathNode = Extract<MarkdownNodeRef, { type: "math" }>

function renderer() {
  const calls: { node: MathNode; commit: boolean; width: number }[] = []
  const nodes: MarkdownNodes = {
    claimsMath: () => true,
    render(node, fallback, col, width, commit) {
      if (node.type !== "math") return fallback
      calls.push({ node, width, commit })
      return [`${" ".repeat(col)}MATH(${node.source})`]
    },
    inline(node, _fallback, width, commit) {
      calls.push({ node, width, commit })
      return `M(${node.source})`
    },
  }
  return { calls, nodes }
}

test("display math supports both delimiters, same-line and multiline, with source preserved", () => {
  const cases: [string, string][] = [
    ["$$x^2$$", "x^2"],
    ["\\[x^2\\]", "x^2"],
    ["$$\nx_1 + x_2\n= y\n$$", "x_1 + x_2\n= y"],
    ["\\[\n  \\frac{x}{y}\n\\]", "  \\frac{x}{y}"],
    ["$$x +\ny$$", "x +\ny"],
  ]
  for (const [text, source] of cases) {
    const { nodes, calls } = renderer()
    const stream = new MarkdownStream({ nodes })
    stream.append(text)
    expect(stream.take(40)).toEqual([`MATH(${source})`])
    expect(calls).toEqual([{ node: { type: "math", display: true, source }, width: 40, commit: true }])
  }
})

test("inline math uses text callbacks inside prose, headings, lists, quotes and emphasis", () => {
  const { nodes, calls } = renderer()
  const text = "one $x_1$ and \\(y^2\\).\n\n# $z$\n\n- $a$\n\n> **$b$**"
  const rows = renderMarkdown(text, 60, defaultTheme, { nodes }).map(stripAnsi)
  expect(rows.join("\n")).toContain("one M(x_1) and M(y^2).")
  expect(rows.join("\n")).toContain("M(z)")
  expect(rows.join("\n")).toContain("M(a)")
  expect(rows.join("\n")).toContain("M(b)")
  expect(calls.every((call) => !call.node.display)).toBe(true)
})

test("inline math inherits surrounding Markdown styles and clickable link targets", () => {
  const nodes: MarkdownNodes = {
    claimsMath: () => true,
    render: (_node, rows) => rows,
    inline: () => "X",
  }
  for (const text of ["**$x$**", "# $x$", "[$x$](https://example.test)"])
    expect(renderMarkdown(text, 40, defaultTheme, { nodes, hyperlinks: true })).toEqual(
      renderMarkdown(text.replace("$x$", "X"), 40, defaultTheme, { hyperlinks: true }),
    )
})

test("math is excluded from code spans, fences, escaped delimiters, currency and bad whitespace", () => {
  const { nodes, calls } = renderer()
  const text = [
    "`$x$` ``\\(y\\)`` \\$z$ \\\\(a\\) costs $5 and $10",
    "$ x$ $x $ $$x$$ and $x$2",
    "```tex",
    "$$x$$",
    "\\(y\\)",
    "```",
    "~~~",
    "\\[",
    "z",
    "\\]",
    "~~~",
  ].join("\n")
  const old = renderMarkdown(text, 80, defaultTheme)
  expect(renderMarkdown(text, 80, defaultTheme, { nodes })).toEqual(old)
  expect(calls).toEqual([])
})

test("unclaimed and declined math preserve legacy Markdown bytes, including raw emphasis and escapes", () => {
  const texts = [
    "a $x_1 + *y*$ and \\(\\alpha + **b**\\)",
    "$$\n*x* + **y**\n\\alpha\n$$\n\nafter",
    "before\n\\[\n*x*\n\\]\nafter",
    "- item\n\n  $$\n  *x*\n  $$\n\nnext",
    "$$x$$\n---",
    "\\[\n[x](https://x.test)\n\\]",
  ]
  for (const text of texts) {
    const old = renderMarkdown(text, 23, defaultTheme, { hyperlinks: false })
    for (const claim of [false, true]) {
      const nodes: MarkdownNodes = {
        claimsMath: () => claim,
        render: (_node, rows) => [...rows],
        inline: (_node, fallback) => fallback,
      }
      expect(renderMarkdown(text, 23, defaultTheme, { hyperlinks: false, nodes })).toEqual(old)
    }
  }
})

test("display math is held through blank lines and live-region pressure until an actual close", () => {
  const { nodes, calls } = renderer()
  const stream = new MarkdownStream({ nodes })
  const committed: string[] = []
  const ctx = { ...plain, commit: (rows: string[]) => committed.push(...rows) }
  stream.maxRows = 1
  stream.append("before\n\n$$\nfirst\n\nsecond\n")
  expect(stream.render(12, ctx).length).toBeLessThanOrEqual(1)
  expect(committed).toEqual(["before"])
  expect(calls).toEqual([])
  stream.append("$$\n\nafter\n")
  stream.render(12, ctx)
  expect(calls.filter((call) => call.commit)).toEqual([
    { node: { type: "math", display: true, source: "first\n\nsecond" }, width: 12, commit: true },
  ])
  expect([...committed, ...stream.take(12)]).toEqual(["before", "", "MATH(first\n\nsecond)", "", "after"])
})

test("inline claims cannot reinterpret the contents of unclaimed display math", () => {
  const { nodes, calls } = renderer()
  nodes.claimsMath = (display) => !display
  for (const text of ["$$\n$x$\n$$", "\\[\n\\(x\\)\n\\]", "$$\n$x$"]) {
    expect(renderMarkdown(text, 40, defaultTheme, { nodes })).toEqual(renderMarkdown(text, 40))
  }
  expect(calls).toEqual([])
})

test("unclosed display math is never rendered, even at finish, and falls back byte-for-byte", () => {
  for (const text of [
    "$$\n*x*\n",
    "\\[\n\\alpha\n",
    "$$x",
    "$$\nx\n$$ trailing",
    "$$\n$x$",
    "\\[\n\\(x\\)",
  ]) {
    const { nodes, calls } = renderer()
    const old = renderMarkdown(text, 12, defaultTheme)
    expect(renderMarkdown(text, 12, defaultTheme, { nodes })).toEqual(old)
    expect(calls).toEqual([])
  }
})

test("a display closing delimiter must match and end the line", () => {
  const { nodes, calls } = renderer()
  const stream = new MarkdownStream({ nodes })
  stream.append("\\[\nx\n$$\n\\] trailing\n\\]  ")
  stream.take(40)
  expect(calls.map((call) => call.node.source)).toEqual(["x\n$$\n\\] trailing"])
})

test("claimed inline math cannot be partially committed while incomplete", () => {
  for (const [open, close] of [
    ["$", "$"],
    ["\\(", "\\)"],
  ]) {
    const { nodes, calls } = renderer()
    const stream = new MarkdownStream({ nodes })
    const committed: string[] = []
    const ctx = { ...plain, commit: (rows: string[]) => committed.push(...rows) }
    stream.maxRows = 1
    stream.append(`prefix ${open}a very long expression with many terms`)
    stream.render(10, ctx)
    expect(committed).toEqual([])
    expect(calls).toEqual([])
    stream.append(`${close} suffix\n\n`)
    stream.render(10, ctx)
    expect(committed.join(" ")).not.toContain(open!)
    expect(
      calls.some((call) => call.commit && call.node.source === "a very long expression with many terms"),
    ).toBe(true)
  }
})

test("a closing dollar is not committed before its following character is known", () => {
  const nodes: MarkdownNodes = {
    claimsMath: () => true,
    render: (_node, rows) => rows,
    inline: () => "replacement long long long",
  }
  for (const suffix of ["2 suffix", "$ suffix"]) {
    const stream = new MarkdownStream({ nodes })
    stream.maxRows = 1
    const committed: string[] = []
    const ctx = { ...plain, commit: (rows: string[]) => committed.push(...rows) }
    stream.append("prefix long $x$")
    stream.render(8, ctx)
    stream.append(suffix)
    stream.render(8, ctx)
    expect([...committed, ...stream.take(8)].map(stripAnsi)).toEqual(
      renderMarkdown(`prefix long $x$${suffix}`, 8, defaultTheme, { nodes }).map(stripAnsi),
    )
  }
})

test("every streamed split agrees with one-shot math output", () => {
  const text = "Before $x$\n\n$$\na + b\n$$\n\nafter \\(z\\)."
  const expected = renderMarkdown(text, 20, defaultTheme, { nodes: renderer().nodes })
  for (let split = 0; split <= text.length; split++) {
    const stream = new MarkdownStream({ nodes: renderer().nodes })
    const committed: string[] = []
    const ctx = { ...plain, theme: defaultTheme, commit: (rows: string[]) => committed.push(...rows) }
    stream.maxRows = 1
    stream.append(text.slice(0, split))
    stream.render(20, ctx)
    stream.append(text.slice(split))
    stream.render(20, ctx)
    expect([...committed, ...stream.take(20)]).toEqual(expected)
  }
})

test("styled inline output wraps by visible width and does not reparse Markdown", () => {
  const nodes: MarkdownNodes = {
    claimsMath: () => true,
    render: (_node, rows) => rows,
    inline: () => "\x1b[31m*αβγδεζηθ*\x1b[0m",
  }
  const rows = renderMarkdown("A $x$ Z", 6, defaultTheme, { nodes })
  expect(rows.map(stripAnsi).join("")).toBe("A*αβγδεζηθ* Z")
  expect(rows.every((row) => visibleWidth(row) <= 6)).toBe(true)
  expect(rows.some((row) => row.includes("\x1b[31m"))).toBe(true)
})

test("complete inline replacements survive partial commits, including styled long replacements", () => {
  for (const replacement of [
    "X",
    "a lengthy mathematical replacement",
    "\x1b[31ma lengthy replacement\x1b[0m",
  ]) {
    const nodes: MarkdownNodes = {
      claimsMath: () => true,
      render: (_node, rows) => rows,
      inline: () => replacement,
    }
    const text = "prefix text $a$ and suffix text \\(b\\) and more text"
    const expected = renderMarkdown(text, 8, defaultTheme, { nodes }).map(stripAnsi)
    const stream = new MarkdownStream({ nodes })
    const committed: string[] = []
    const ctx = { ...plain, theme: defaultTheme, commit: (rows: string[]) => committed.push(...rows) }
    stream.maxRows = 1
    for (const char of text) {
      stream.append(char)
      stream.render(8, ctx)
    }
    expect([...committed, ...stream.take(8)].map(stripAnsi)).toEqual(expected)
  }
})

test("partial commits retain escape and adjacent-dollar context", () => {
  for (const prefix of ["aaaaaaaa\\$xy", "aaaaaaa$$x"]) {
    const { nodes, calls } = renderer()
    nodes.inline = (node, _fallback, width, commit) => {
      calls.push({ node, width, commit })
      return "M"
    }
    const stream = new MarkdownStream({ nodes })
    const committed: string[] = []
    const ctx = { ...plain, commit: (rows: string[]) => committed.push(...rows) }
    stream.maxRows = 1
    stream.append(prefix)
    stream.render(8, ctx)
    stream.append("$ ")
    expect([...committed, ...stream.take(8)].map(stripAnsi)).toEqual(
      renderMarkdown(`${prefix}$ `, 8, defaultTheme, { nodes }).map(stripAnsi),
    )
    expect(calls).toEqual([])
  }
})

test("accepted display blocks reset list nesting like a code fence", () => {
  for (const delimiter of ["$$x$$", "\\[x\\]"]) {
    const { nodes } = renderer()
    expect(
      renderMarkdown(`- item\n\n${delimiter}\nafter`, 40, defaultTheme, { nodes }).map(stripAnsi),
    ).toEqual(["• item", "", "MATH(x)", "after"])
    expect(
      renderMarkdown(`1. item\n\n${delimiter}\n1. next`, 40, defaultTheme, { nodes }).map(stripAnsi),
    ).toEqual(["1. item", "", "MATH(x)", "1. next"])
  }
})

test("TUI math excludes multiline code spans without changing legacy rendering", () => {
  for (const body of ["$x$", "$$x$$", "\\[x\\]", "$$\nx\n$$", "\\[\nx\n\\]"]) {
    const source = `Use \`cost\n${body}\nvalue\` here.`
    const { nodes, calls } = renderer()
    const expected = renderMarkdown(source, 40, defaultTheme)
    expect(renderMarkdown(source, 40, defaultTheme, { nodes })).toEqual(expected)
    const stream = new MarkdownStream({ nodes })
    const committed: string[] = []
    const ctx = { ...plain, theme: defaultTheme, commit: (rows: string[]) => committed.push(...rows) }
    stream.maxRows = 1
    for (const char of source) {
      stream.append(char)
      stream.render(40, ctx)
    }
    expect([...committed, ...stream.take(40)]).toEqual(expected)
    expect(calls).toEqual([])
  }
})

test("multiline code exclusion preserves neighboring math and exact backtick matching", () => {
  for (const source of [
    "$before$ `cost\n$x$\nvalue` $after$",
    "$before$ ``cost\n` $x$ `\nvalue`` $after$",
    "long prefix words before `cost\n$x$\nvalue` $after$",
  ]) {
    const { nodes, calls } = renderer()
    const expected = renderMarkdown(source, 8, defaultTheme, { nodes })
    const stream = new MarkdownStream({ nodes })
    const committed: string[] = []
    const ctx = { ...plain, theme: defaultTheme, commit: (rows: string[]) => committed.push(...rows) }
    stream.maxRows = 1
    for (const char of source) {
      stream.append(char)
      stream.render(8, ctx)
    }
    expect([...committed, ...stream.take(8)]).toEqual(expected)
    expect(calls.some(({ node }) => node.source === "x")).toBe(false)
    expect(calls.some(({ node }) => node.source === "after")).toBe(true)
    expect(mathSources(source).map(({ source }) => source)).toEqual(
      source.startsWith("$before$") ? ["before", "after"] : ["after"],
    )
  }
})

test("TUI unmatched backticks do not hide real math at finish", () => {
  const { nodes } = renderer()
  const source = "Use `cost\n$x$\n$$y$$\n\\[z\\]\nafter"
  expect(renderMarkdown(source, 40, defaultTheme, { nodes }).map(stripAnsi)).toEqual([
    "Use `cost",
    "M(x)",
    "MATH(y)",
    "MATH(z)",
    "after",
  ])
})

test("source math excludes multiline code spans but not unmatched backticks", () => {
  for (const body of ["$x$", "$$x$$", "\\[x\\]", "$$\nx\n$$", "\\[\nx\n\\]"]) {
    const text = `Use \`cost\n${body}\nvalue\` here. $yes$`
    expect(mathSources(text).map(({ source }) => source)).toEqual(["yes"])
    expect(mathSources(`Use \`cost\n${body}\nvalue here.`).map(({ source }) => source)).toEqual(["x"])
  }
})

test("source parser exposes source offsets and uses the same delimiter and code rules", () => {
  const text = "`$no$` costs $5 and $10\n$$\na + b\n$$\nthen \\(x\\) and $y$\n```\n$no$\n```\n\\[unclosed"
  const parsed = mathSources(text)
  expect(parsed.map(({ source, display }) => ({ source, display }))).toEqual([
    { source: "a + b", display: true },
    { source: "x", display: false },
    { source: "y", display: false },
  ])
  expect(parsed.map(({ start, end }) => text.slice(start, end))).toEqual(["$$\na + b\n$$", "\\(x\\)", "$y$"])
  expect(inlineMathAt("$x", 0)).toBe("open")
  expect(inlineMathAt("$ x$", 0)).toBeUndefined()
  expect(inlineMathAt("$x$2", 0)).toBe("open")
})

test("ordinary dollar signs stay text with a claiming renderer", () => {
  for (const text of [
    "It costs $5 and $10 total",
    "echo $HOME and $PATH now",
    "use $1 and $2, price $5.50 vs $6",
    "cost $5, then unclosed $x + y",
    "unclosed $ at end",
    "see http://x.com/a$b$c",
    "| a | b |\n|---|---|\n| $1 | $2 |",
    "```\n$$\nx\n```\ntext",
  ]) {
    const { nodes, calls } = renderer()
    expect(renderMarkdown(text, 80, defaultTheme, { nodes })).toEqual(renderMarkdown(text, 80, defaultTheme))
    expect(calls).toEqual([])
  }
})

test("an unclosed inline dollar does not swallow the following lines", () => {
  const { nodes } = renderer()
  const rows = renderMarkdown("cost $x + y\nthen $a$ here", 80, defaultTheme, { nodes }).map(stripAnsi)
  expect(rows).toEqual(["cost $x + y", "then M(a) here"])
})

test("long lines with many unmatched delimiters are scanned in linear time", () => {
  const { nodes } = renderer()
  for (const unit of ["$a ", "\(a ", "$a\\", "\\"]) {
    const text = unit.repeat(40000)
    const start = performance.now()
    mathSources(text)
    renderMarkdown(text, 80, defaultTheme, { nodes })
    expect(performance.now() - start).toBeLessThan(2000)
  }
})
