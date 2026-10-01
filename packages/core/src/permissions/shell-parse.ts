/**
 * Conservative readers of shell command lines for the permission policy: they split a line
 * into its simple commands (at `&&`, `||`, `;`, `|` and newlines) and give each one's words
 * with the quoting removed. Anything they cannot read word for word (substitutions,
 * expansions, redirections into files, here-documents, grouping, eval and the like) makes
 * the line `complex`; the words found are still returned, for deny rules to look at.
 *
 * These are not full shell grammars: when in doubt a construct counts as complex.
 */

export interface ParsedLine {
  /** The simple commands in order, each its words without quotes. */
  commands: string[][]
  /** Why the line cannot be checked word by word; undefined when it can. */
  complex?: string
}

/** Commands that run other commands or code given as words: their arguments decide what runs. */
const BASH_WRAPPERS = new Set([
  ".",
  "builtin",
  "busybox",
  "command",
  "doas",
  "env",
  "eval",
  "exec",
  "nice",
  "nohup",
  "setsid",
  "source",
  "stdbuf",
  "su",
  "sudo",
  "time",
  "timeout",
  "watch",
  "xargs",
  ...shellNames(),
])

const BASH_KEYWORDS = new Set([
  "!",
  "[[",
  "]]",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "then",
  "until",
  "while",
])

const POWERSHELL_WRAPPERS = new Set([
  ".",
  "icm",
  "iex",
  "ii",
  "invoke-command",
  "invoke-expression",
  "invoke-item",
  "saps",
  "start",
  "start-job",
  "start-process",
  "start-threadjob",
  "wsl",
  ...shellNames(),
])

/** Shells and interpreters: what they run is a script or code given as a word. */
function shellNames(): string[] {
  return [
    "bash",
    "cmd",
    "cscript",
    "csh",
    "dash",
    "fish",
    "ksh",
    "lua",
    "mshta",
    "node",
    "osascript",
    "perl",
    "php",
    "powershell",
    "pwsh",
    "py",
    "python",
    "python2",
    "python3",
    "ruby",
    "sh",
    "tcsh",
    "wscript",
    "zsh",
  ]
}

/** A command run by its path (`./build.sh`, `.\deploy.ps1`) or named like a script file. */
function isScript(word: string): boolean {
  return (
    /^\.{1,2}[\\/]/.test(word) || /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|vbs)$/i.test(word)
  )
}

/**
 * PowerShell reads typographic quotes as quotes and dashes as hyphens; so does this reader,
 * or `git ‘push’` would hide its words from the rules.
 */
function plainPunctuation(src: string): string {
  return src
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—―]/g, "-")
}

/**
 * A command name as rules compare it: the last path part, lower case, without a Windows
 * program extension, so `/usr/bin/git`, `GIT` and `git.exe` are all `git`.
 */
export function commandName(word: string): string {
  const base = word.split(/[\\/]/).at(-1) ?? word
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "")
}

/** Reads a bash (or POSIX sh) command line. */
export function parseBash(src: string): ParsedLine {
  const commands: string[][] = []
  let words: string[] = []
  let cur: string | null = null
  /** The word being read has an unquoted glob character. */
  let glob = false
  /** The command being read has a glob in its first word. */
  let globName = false
  let complex: string | undefined
  const mark = (why: string) => {
    complex ??= why
  }
  const add = (s: string) => {
    cur = (cur ?? "") + s
  }
  const flush = () => {
    if (cur === null) return
    if (glob && words.length === 0) globName = true
    words.push(cur)
    cur = null
    glob = false
  }
  const end = () => {
    flush()
    if (words.length) {
      if (globName) mark("a pattern in the command name")
      commands.push(words)
    }
    words = []
    globName = false
  }
  const n = src.length
  let i = 0
  /** Reads the word after a redirection operator, quotes removed; "" when there is none. */
  const target = (): string => {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++
    let out = ""
    while (i < n && !/[\s;&|<>()]/.test(src[i]!)) {
      const c = src[i]!
      if (c === "'" || c === '"') {
        const close = src.indexOf(c, i + 1)
        if (close < 0) {
          mark("an unterminated quote")
          out += src.slice(i + 1)
          i = n
          break
        }
        out += src.slice(i + 1, close)
        i = close + 1
        continue
      }
      if (c === "$" || c === "`") mark("an expansion in a redirection")
      if (c === "\\" && i + 1 < n) {
        out += src[i + 1]
        i += 2
        continue
      }
      out += c
      i++
    }
    return out
  }
  while (i < n) {
    const c = src[i]!
    const next = src[i + 1]
    if (c === " " || c === "\t" || c === "\r") {
      flush()
      i++
    } else if (c === "\n") {
      end()
      i++
    } else if (c === "\\") {
      if (next === "\n") i += 2
      else if (next === undefined) {
        add("\\")
        i++
      } else {
        add(next)
        i += 2
      }
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      if (close < 0) {
        mark("an unterminated quote")
        add(src.slice(i + 1))
        i = n
      } else {
        add(src.slice(i + 1, close))
        i = close + 1
      }
    } else if (c === '"') {
      i++
      let s = ""
      let closed = false
      while (i < n) {
        const d = src[i]!
        if (d === '"') {
          closed = true
          i++
          break
        }
        if (d === "\\" && i + 1 < n) {
          const e = src[i + 1]!
          if (e === "\n") {
            i += 2
            continue
          }
          if ('$`"\\'.includes(e)) {
            s += e
            i += 2
            continue
          }
          s += d
          i++
          continue
        }
        if (d === "`") mark("a command substitution")
        if (d === "$" && i + 1 < n && /[A-Za-z0-9_{(@*#?$!-]/.test(src[i + 1]!)) mark("an expansion")
        s += d
        i++
      }
      if (!closed) mark("an unterminated quote")
      add(s)
    } else if (c === "$") {
      if (next !== undefined && /[A-Za-z0-9_{(@*#?$!'"-]/.test(next)) {
        mark(next === "(" ? "a command substitution" : "an expansion")
      }
      add(c)
      i++
    } else if (c === "`") {
      mark("a command substitution")
      add(c)
      i++
    } else if (c === "#" && cur === null) {
      while (i < n && src[i] !== "\n") i++
    } else if (c === ";") {
      if (next === ";" || next === "&") mark("a case clause")
      end()
      i++
    } else if (c === "&") {
      if (next === "&") {
        end()
        i += 2
      } else if (next === ">") {
        // &> and &>> redirect both streams.
        flush()
        i += next === ">" && src[i + 2] === ">" ? 3 : 2
        const to = target()
        if (to !== "/dev/null") mark("a redirection to a file")
      } else {
        // A command sent to the background; the next one starts after it.
        end()
        i++
      }
    } else if (c === "|") {
      end()
      i += next === "|" || next === "&" ? 2 : 1
    } else if (c === "<" || c === ">") {
      // A number right before the operator is the stream it redirects (2>), not a word.
      if (cur !== null && /^\d+$/.test(cur)) cur = null
      flush()
      if (next === "(") {
        mark("a process substitution")
        add(c)
        i++
        continue
      }
      let op = c
      i++
      while (i < n && /[<>&|]/.test(src[i]!) && op.length < 3) {
        op += src[i]
        i++
      }
      if (op.startsWith("<<")) {
        mark(op === "<<<" ? "a here-string" : "a here-document")
        target()
        continue
      }
      const to = target()
      const dup = op.endsWith("&") && /^(\d+|-)$/.test(to)
      if (!dup && to !== "/dev/null") mark(c === "<" ? "an input redirection" : "a redirection to a file")
    } else if (c === "(" || c === ")") {
      mark("a subshell or grouping")
      end()
      i++
    } else if (c === "{" || c === "}") {
      mark("braces (grouping or brace expansion)")
      add(c)
      i++
    } else {
      if (c === "*" || c === "?" || c === "[") glob = true
      add(c)
      i++
    }
  }
  end()
  for (const argv of commands) {
    const first = argv[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(first)) mark("a variable assignment before the command")
    else if (BASH_KEYWORDS.has(first)) mark(`the shell keyword "${first}"`)
    else if (BASH_WRAPPERS.has(commandName(first))) mark(`"${first}", which runs other commands`)
    else if (isScript(first)) mark(`the script "${first}"`)
  }
  return complex === undefined ? { commands } : { commands, complex }
}

/** Reads a PowerShell (Windows PowerShell 5.1 or PowerShell 7) command line. */
export function parsePowerShell(line: string): ParsedLine {
  const src = plainPunctuation(line)
  const commands: string[][] = []
  let words: string[] = []
  let cur: string | null = null
  let complex: string | undefined
  const mark = (why: string) => {
    complex ??= why
  }
  const add = (s: string) => {
    cur = (cur ?? "") + s
  }
  const flush = () => {
    if (cur === null) return
    words.push(cur)
    cur = null
  }
  const end = () => {
    flush()
    if (words.length) commands.push(words)
    words = []
  }
  const n = src.length
  let i = 0
  const target = (): string => {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++
    let out = ""
    while (i < n && !/[\s;&|<>(){}]/.test(src[i]!)) {
      const c = src[i]!
      if (c === "'" || c === '"') {
        const close = src.indexOf(c, i + 1)
        if (close < 0) {
          mark("an unterminated quote")
          out += src.slice(i + 1)
          i = n
          break
        }
        out += src.slice(i + 1, close)
        i = close + 1
        continue
      }
      out += c
      i++
    }
    return out
  }
  while (i < n) {
    const c = src[i]!
    const next = src[i + 1]
    if (c === " " || c === "\t" || c === "\r") {
      flush()
      i++
    } else if (c === "\n") {
      end()
      i++
    } else if (c === "`") {
      if (next === "\n") i += 2
      else if (next === "\r" && src[i + 2] === "\n") i += 3
      else if (next === undefined) {
        add("`")
        i++
      } else {
        add(next)
        i += 2
      }
    } else if (c === "'") {
      // '' inside single quotes is one quote.
      i++
      let s = ""
      let closed = false
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'"
            i += 2
            continue
          }
          closed = true
          i++
          break
        }
        s += src[i]
        i++
      }
      if (!closed) mark("an unterminated quote")
      add(s)
    } else if (c === '"') {
      i++
      let s = ""
      let closed = false
      while (i < n) {
        const d = src[i]!
        if (d === '"') {
          if (src[i + 1] === '"') {
            s += '"'
            i += 2
            continue
          }
          closed = true
          i++
          break
        }
        if (d === "`" && i + 1 < n) {
          s += src[i + 1]
          i += 2
          continue
        }
        if (d === "$" && i + 1 < n && /[A-Za-z0-9_{(?^$:]/.test(src[i + 1]!)) mark("an expansion")
        s += d
        i++
      }
      if (!closed) mark("an unterminated quote")
      add(s)
    } else if (c === "$") {
      if (next !== undefined && /[A-Za-z0-9_{(?^$:]/.test(next)) {
        mark(next === "(" ? "a subexpression" : "a variable")
      }
      add(c)
      i++
    } else if (c === "@" && cur === null && next !== undefined && /[({"'A-Za-z_]/.test(next)) {
      mark(next === '"' || next === "'" ? "a here-string" : "an array, hashtable or splatting")
      add(c)
      i++
    } else if (c === "#" && cur === null) {
      while (i < n && src[i] !== "\n") i++
    } else if (c === "<" && next === "#") {
      mark("a block comment")
      i += 2
    } else if (c === ";") {
      end()
      i++
    } else if (c === "|") {
      end()
      i += next === "|" ? 2 : 1
    } else if (c === "&") {
      if (next === "&") {
        end()
        i += 2
      } else {
        mark(cur === null && words.length === 0 ? "the call operator &" : "a background job")
        flush()
        i++
      }
    } else if (c === ">" || (c === "<" && cur === null)) {
      if (c === "<") {
        mark("an input redirection")
        i++
        continue
      }
      // 2> or *> : the stream number or * before the operator is not a word.
      if (cur !== null && /^(\d|\*)$/.test(cur)) cur = null
      flush()
      let op = c
      i++
      while (i < n && /[>&]/.test(src[i]!) && op.length < 3) {
        op += src[i]
        i++
      }
      const to = target()
      const dup = op.endsWith("&") && /^\d$/.test(to)
      if (!dup && to.toLowerCase() !== "$null") mark("a redirection to a file")
    } else if (c === "(" || c === ")") {
      mark("a subexpression or grouping")
      end()
      i++
    } else if (c === "{" || c === "}") {
      mark("a script block")
      add(c)
      i++
    } else if (c === "[" && cur === null) {
      mark("a type expression")
      add(c)
      i++
    } else {
      add(c)
      i++
    }
  }
  end()
  for (const argv of commands) {
    const first = argv[0]!
    if (argv.includes("--%")) mark("the stop-parsing token --%")
    if (/^\$/.test(first)) mark("a variable or assignment")
    else if (POWERSHELL_WRAPPERS.has(commandName(first))) mark(`"${first}", which runs other commands`)
    else if (isScript(first)) mark(`the script "${first}"`)
  }
  return complex === undefined ? { commands } : { commands, complex }
}
