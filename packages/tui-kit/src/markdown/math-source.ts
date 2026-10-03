/** A complete math expression, with source offsets including its delimiters. */
export interface MathSource {
  start: number
  end: number
  display: boolean
  source: string
}

/** Whether the character at `at` is backslash-escaped. */
function escaped(text: string, at: number): boolean {
  let n = 0
  while (at > 0 && text[--at] === "\\") n++
  return n % 2 === 1
}

/** A single-line inline expression, or `open` when more input could close it. */
export function inlineMathAt(text: string, at: number, end = text.length): MathSource | "open" | undefined {
  if (escaped(text, at)) return
  const dollar = text[at] === "$" && text[at - 1] !== "$" && text[at + 1] !== "$"
  const paren = text.startsWith("\\(", at)
  if (!dollar && !paren) return
  const from = at + (dollar ? 1 : 2)
  if (dollar && from < end && /\s/.test(text[from]!)) return
  for (let i = from; i < end; i++) {
    if (text[i] === "\n") return
    if (escaped(text, i)) continue
    if (paren && text.startsWith("\\)", i) && i + 2 <= end)
      return i > from ? { start: at, end: i + 2, display: false, source: text.slice(from, i) } : undefined
    if (!dollar || text[i] !== "$" || text[i - 1] === "$" || text[i + 1] === "$") continue
    // Currency-like endings ($5 and $10), and whitespace against either delimiter, are not math.
    if (i === from || /\s/.test(text[i - 1]!) || /\d/.test(text[i + 1] ?? "")) continue
    return { start: at, end: i + 1, display: false, source: text.slice(from, i) }
  }
  return "open"
}

export interface DisplayMathStart {
  close: "$$" | "\\]"
  /** Offset after the opening delimiter, including indentation. */
  from: number
}

/** Display delimiters start a source line, after optional indentation. */
export function displayMathStart(line: string): DisplayMathStart | undefined {
  const m = line.match(/^\s*(\$\$(?!\$)|\\\[)/)
  if (!m) return
  return { close: m[1] === "$$" ? "$$" : "\\]", from: m[0].length }
}

/** A display closing delimiter must end its line (apart from whitespace). */
export function displayMathEnd(line: string, close: DisplayMathStart["close"], from = 0): number | undefined {
  const end = line.trimEnd().length
  const at = end - close.length
  if (at < from || !line.startsWith(close, at) || escaped(line, at)) return
  if (close === "$$" && line[at - 1] === "$") return
  return at
}

/** Source inside display delimiters; delimiter-only lines do not add leading/trailing newlines. */
export function displayMathSource(lines: string[], start: DisplayMathStart): string {
  const body = [...lines]
  body[0] = body[0]!.slice(start.from)
  const last = body.length - 1
  const close = displayMathEnd(body[last]!, start.close)!
  body[last] = body[last]!.slice(0, close)
  if (body.length > 1 && body[0]!.trim() === "") body.shift()
  if (body.length > 1 && body[body.length - 1]!.trim() === "") body.pop()
  return body.join("\n")
}

/** End of a code span with an exactly matching backtick run, including across source lines. */
function codeSpanEnd(text: string, at: number): number | undefined {
  const ticks = text.slice(at).match(/^`+/)![0]
  let end = text.indexOf(ticks, at + ticks.length)
  while (end !== -1) {
    if (text[end - 1] !== "`" && text[end + ticks.length] !== "`") return end + ticks.length
    end = text.indexOf(ticks, end + ticks.length)
  }
}

export interface MathCodeRange {
  start: number
  end: number
}

/**
 * Code spans touching the first source line. `through` continues a span from a previous line.
 * Undefined means an unmatched run still needs lookahead; at finish it is ordinary Markdown.
 * Call only outside fenced code and display math, which own their contents.
 */
export function mathCodeLine(
  text: string,
  through = 0,
  final = false,
): { ranges: MathCodeRange[]; through: number } | undefined {
  const newline = text.indexOf("\n")
  const length = newline === -1 ? text.length : newline
  const ranges: MathCodeRange[] = through > 0 ? [{ start: 0, end: through }] : []
  for (let i = through; i < length; i++) {
    if (escaped(text, i)) continue
    if (text[i] === "`") {
      const end = codeSpanEnd(text, i)
      if (end === undefined || (!final && end === text.length)) {
        if (!final) return
        i += text.slice(i).match(/^`+/)![0].length - 1
      } else {
        ranges.push({ start: i, end })
        through = end
        i = end - 1
      }
    } else {
      const math = inlineMathAt(text, i, length)
      if (math && math !== "open") i = math.end - 1
    }
  }
  return { ranges, through }
}

/** Complete math in Markdown source, skipping fenced code, code spans and escaped delimiters. */
export function mathSources(text: string): MathSource[] {
  const out: MathSource[] = []
  let fence: { char: string; length: number } | undefined
  let display: { start: number; opener: DisplayMathStart; lines: string[] } | undefined
  let offset = 0
  let codeThrough = 0
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (display) {
      display.lines.push(line)
      if (displayMathEnd(line, display.opener.close) !== undefined) {
        out.push({
          start: display.start,
          end: offset + line.trimEnd().length,
          display: true,
          source: displayMathSource(display.lines, display.opener),
        })
        display = undefined
      }
    } else if (fence) {
      const close = line.match(/^\s*(`+|~+)\s*$/)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined
    } else {
      const code = offset >= codeThrough && line.match(/^\s*(`{3,}|~{3,})(.*)$/)
      const opener = offset >= codeThrough && displayMathStart(line)
      if (code && !(code[1]![0] === "`" && code[2]!.includes("`")))
        fence = { char: code[1]![0]!, length: code[1]!.length }
      else if (opener) {
        if (displayMathEnd(line, opener.close, opener.from) !== undefined)
          out.push({
            start: offset,
            end: offset + line.trimEnd().length,
            display: true,
            source: displayMathSource([line], opener),
          })
        else display = { start: offset, opener, lines: [line] }
      } else {
        for (let i = Math.max(0, codeThrough - offset); i < line.length; i++) {
          if (line[i] === "\\" && !line.startsWith("\\(", i)) {
            i++
            continue
          }
          if (line[i] === "`") {
            const end = codeSpanEnd(text, offset + i)
            if (end === undefined) i += line.slice(i).match(/^`+/)![0].length - 1
            else {
              codeThrough = end
              i = end - offset - 1
            }
            continue
          }
          const math = inlineMathAt(line, i)
          if (math && math !== "open") {
            out.push({ ...math, start: offset + math.start, end: offset + math.end })
            i = math.end - 1
          }
        }
      }
    }
    offset += rawLine.length + 1
  }
  return out
}
