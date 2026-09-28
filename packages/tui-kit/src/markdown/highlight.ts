import type { MarkdownStyles, Run } from "./inline.ts"

interface Language {
  keywords: Set<string>
  literals: Set<string>
  /** Starts a comment that runs to the end of the line. */
  lineComment: string[]
  /** Quote characters of string literals. */
  quotes: string
}

const words = (s: string) => new Set(s.split(" "))

const C_LIKE_LITERALS = words("true false null undefined nil None True False self this super")

const LANGUAGES: Record<string, Language> = {
  ts: {
    keywords: words(
      "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static switch throw try type typeof var void while with yield",
    ),
    literals: C_LIKE_LITERALS,
    lineComment: ["//"],
    quotes: "\"'`",
  },
  py: {
    keywords: words(
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield",
    ),
    literals: C_LIKE_LITERALS,
    lineComment: ["#"],
    quotes: "\"'",
  },
  rust: {
    keywords: words(
      "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct trait type unsafe use where while",
    ),
    literals: words("true false Self self Some None Ok Err"),
    lineComment: ["//"],
    quotes: '"',
  },
  go: {
    keywords: words(
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    ),
    literals: words("true false nil iota"),
    lineComment: ["//"],
    quotes: "\"'`",
  },
  sh: {
    keywords: words(
      "if then else elif fi case esac for while until do done in function return local export set unset echo exit source alias param foreach begin process end try catch throw",
    ),
    literals: words("true false $true $false $null"),
    lineComment: ["#"],
    quotes: "\"'",
  },
  json: {
    keywords: new Set(),
    literals: words("true false null"),
    lineComment: [],
    quotes: '"',
  },
  cs: {
    keywords: words(
      "abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach get if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly record ref return sealed set short sizeof static string struct switch throw try typeof uint ulong using var virtual void volatile while yield",
    ),
    literals: C_LIKE_LITERALS,
    lineComment: ["//"],
    quotes: "\"'",
  },
}

const ALIASES: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  jsx: "ts",
  javascript: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "py",
  python: "py",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  sh: "sh",
  bash: "sh",
  shell: "sh",
  zsh: "sh",
  console: "sh",
  ps1: "sh",
  powershell: "sh",
  pwsh: "sh",
  json: "json",
  jsonc: "json",
  cs: "cs",
  csharp: "cs",
  "c#": "cs",
}

const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|\s+|./gy

/**
 * Colors one line of code: keywords, literals, numbers, strings and line comments. It knows a
 * handful of languages and nothing that spans lines (a string or comment is closed at the end
 * of the line); an unknown language gets plain text.
 *
 * The first `skip` characters are not shown: they are the `carry` of a run an earlier part of the
 * line was cut in (an open quote, a comment's start), so the rest is colored as it was.
 */
export function highlightLine(lang: string, line: string, styles: MarkdownStyles, skip = 0): Run[] {
  const name = ALIASES[lang.toLowerCase()]
  const language = name ? LANGUAGES[name] : undefined
  if (!language || line.length <= skip) return line.length <= skip ? [] : [plain(line.slice(skip), skip)]
  const out: Run[] = []
  let textStart = 0
  const push = (from: number, to: number, style: (typeof styles)[keyof typeof styles], carry = "") => {
    if (from > textStart) out.push(plain(line.slice(textStart, from), textStart))
    out.push({ text: line.slice(from, to), src: from, style, carry, cuttable: true })
    textStart = to
  }
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    const comment = language.lineComment.find((p) => line.startsWith(p, i))
    if (comment) {
      push(i, line.length, styles.comment, comment)
      break
    }
    if (language.quotes.includes(c)) {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1
      const end = Math.min(line.length, j + 1)
      push(i, end, styles.string, c)
      i = end
      continue
    }
    TOKEN.lastIndex = i
    const tok = TOKEN.exec(line)![0]
    if (/^\d/.test(tok)) push(i, i + tok.length, styles.number)
    else if (language.keywords.has(tok)) push(i, i + tok.length, styles.keyword)
    else if (language.literals.has(tok)) push(i, i + tok.length, styles.number)
    i += tok.length
  }
  if (textStart < line.length) out.push(plain(line.slice(textStart), textStart))
  if (skip === 0) return out
  return out.flatMap((r) => {
    const end = r.src + r.text.length
    if (end <= skip) return []
    return r.src >= skip ? [r] : [{ ...r, text: r.text.slice(skip - r.src), src: skip }]
  })
}

/**
 * What a cut `off` characters into a run of highlighted code carries: the run's quote or comment
 * start, and a backslash the cut separated from the character it escapes.
 */
export function codeCarry(run: Run, off: number): string {
  // At its start the rest begins with the quote or comment start itself.
  if (off === 0) return ""
  if (run.carry.length !== 1) return run.carry
  const slashes = run.text.slice(1, off).match(/\\*$/)![0].length
  return slashes % 2 ? `${run.carry}\\` : run.carry
}

function plain(text: string, src: number): Run {
  return { text, src, carry: "", cuttable: true }
}
