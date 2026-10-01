export interface AddOperation {
  kind: "add"
  path: string
  content: string
}

export interface DeleteOperation {
  kind: "delete"
  path: string
}

export interface UpdateHunk {
  context?: string
  oldLines: string[]
  newLines: string[]
  contextLineIndices: [number, number][]
  endOfFile: boolean
}

export interface UpdateOperation {
  kind: "update"
  path: string
  moveTo?: string
  hunks: UpdateHunk[]
}

export type PatchOperation = AddOperation | DeleteOperation | UpdateOperation

const begin = "*** Begin Patch"
const end = "*** End Patch"
const eof = "*** End of File"

// Grammar and leniencies follow openai/codex's apply-patch parser and streaming_parser.
export function parsePatch(input: string): PatchOperation[] {
  let lines = input.trim().split(/\r?\n/)
  if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]!) && lines.at(-1)?.endsWith("EOF")) {
    lines = lines.slice(1, -1)
  }
  if (lines[0]?.trim() !== begin) throw new Error(`Invalid patch: first line must be '${begin}'`)
  if (lines.at(-1)?.trim() !== end) throw new Error(`Invalid patch: last line must be '${end}'`)

  const operations: PatchOperation[] = []
  let current: PatchOperation | undefined
  const fail = (index: number, message: string): never => {
    throw new Error(`Invalid patch at line ${index + 1}${current ? ` (${current.path})` : ""}: ${message}`)
  }
  const checkUpdate = (index: number) => {
    if (current?.kind !== "update") return
    if (!current.hunks.length) fail(index, "Update file hunk is empty")
    const last = current.hunks.at(-1)!
    if (!last.oldLines.length && !last.newLines.length) fail(index, "Update hunk does not contain any lines")
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    const marker = current?.kind === "update" ? line.trimEnd() : line.trim()
    if (marker.startsWith("*** Environment ID:")) {
      fail(i, "Environment ID is unsupported; patches apply to the current workspace")
    }
    if (marker === end || (i === lines.length - 1 && line.trim() === end)) {
      checkUpdate(i)
      if (i !== lines.length - 1) fail(i, "Unexpected content after End Patch")
      return operations
    }
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(marker)
    if (header) {
      checkUpdate(i)
      const path = header[2]!
      current =
        header[1] === "Add"
          ? { kind: "add", path, content: "" }
          : header[1] === "Delete"
            ? { kind: "delete", path }
            : { kind: "update", path, hunks: [] }
      operations.push(current)
      continue
    }
    if (current?.kind === "add") {
      if (!line.startsWith("+")) fail(i, "Every line of an added file must start with '+'")
      current.content += `${line.slice(1)}\n`
      continue
    }
    if (current?.kind !== "update") fail(i, "Expected an Add File, Delete File, or Update File header")
    const update = current as UpdateOperation
    let hunk = update.hunks.at(-1)
    if (hunk?.endOfFile && marker === "") continue
    if (hunk?.endOfFile && marker !== "@@" && !marker.startsWith("@@ ")) {
      fail(i, "Expected @@ after End of File")
    }
    if (!update.hunks.length && !update.moveTo && marker.startsWith("*** Move to: ")) {
      update.moveTo = marker.slice("*** Move to: ".length)
      continue
    }
    if (marker === "@@" || marker.startsWith("@@ ")) {
      if (hunk && !hunk.oldLines.length && !hunk.newLines.length) {
        fail(i, "Update hunk does not contain any lines")
      }
      update.hunks.push({
        context: marker === "@@" ? undefined : marker.slice(3),
        oldLines: [],
        newLines: [],
        contextLineIndices: [],
        endOfFile: false,
      })
      continue
    }
    if (marker === eof) {
      if (!hunk || (!hunk.oldLines.length && !hunk.newLines.length)) {
        fail(i, "End of File requires a nonempty update hunk")
      }
      hunk!.endOfFile = true
      continue
    }
    if (line !== "" && ![" ", "+", "-"].includes(line[0]!)) {
      fail(i, "Every update line must start with ' ' (context), '+' (added), or '-' (removed)")
    }
    if (!hunk) {
      hunk = { oldLines: [], newLines: [], contextLineIndices: [], endOfFile: false }
      update.hunks.push(hunk)
    }
    const value = line.slice(1)
    if (line === "" || line.startsWith(" ")) {
      hunk.contextLineIndices.push([hunk.oldLines.length, hunk.newLines.length])
      hunk.oldLines.push(value)
      hunk.newLines.push(value)
    } else if (line.startsWith("-")) hunk.oldLines.push(value)
    else hunk.newLines.push(value)
  }
  throw new Error(`Invalid patch: last line must be '${end}'`)
}

interface SourceLine {
  text: string
  eol: string
}

interface Replacement {
  start: number
  count: number
  lines: SourceLine[]
}

function sourceLines(text: string): SourceLine[] {
  const result: SourceLine[] = []
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (match[0] !== "") result.push({ text: match[1]!, eol: match[2]! })
  }
  return result
}

function normalize(line: string): string {
  return line
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ")
}

function seek(lines: SourceLine[], pattern: string[], start: number, atEnd: boolean): number {
  if (!pattern.length) return start
  const first = atEnd ? Math.max(start, lines.length - pattern.length) : start
  const transforms = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim(), normalize]
  for (const transform of transforms) {
    for (let i = first; i <= lines.length - pattern.length; i++) {
      if (pattern.every((line, j) => transform(line) === transform(lines[i + j]!.text))) return i
    }
  }
  return -1
}

function mismatch(path: string, hunk: number, lines: SourceLine[], pattern: string[], start: number): Error {
  let closest = -1
  let best = -1
  // Similarity is diagnostic only; it never relaxes the actual matching rules.
  for (let i = 0; i < lines.length; i++) {
    let score = 0
    for (let j = 0; j < pattern.length && i + j < lines.length; j++) {
      const a = normalize(pattern[j]!)
      const b = normalize(lines[i + j]!.text)
      if (a === b) score += 1
      else {
        let prefix = 0
        while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++
        score += prefix / Math.max(a.length, b.length, 1)
      }
    }
    if (score > best) {
      best = score
      closest = i
    }
  }
  const expected = pattern.map((line) => `  ${JSON.stringify(line)}`).join("\n")
  const actual =
    closest < 0
      ? "  (file is empty)"
      : lines
          .slice(closest, closest + Math.max(pattern.length, 1))
          .map((line, i) => `  ${closest + i + 1}: ${JSON.stringify(line.text)}`)
          .join("\n")
  return new Error(
    `${path}: hunk ${hunk} failed to match at or after line ${start + 1}. Hunks must be ordered and must not overlap.\nExpected context:\n${expected}\nClosest match${closest < 0 ? "" : ` at line ${closest + 1}`} (not applied):\n${actual}`,
  )
}

export function applyUpdate(text: string, operation: UpdateOperation): string {
  const lines = sourceLines(text)
  const replacements: Replacement[] = []
  const defaultEol = lines.find((line) => line.eol)?.eol ?? "\n"
  let cursor = 0
  for (const [index, hunk] of operation.hunks.entries()) {
    if (hunk.context !== undefined) {
      const context = seek(lines, [hunk.context], cursor, false)
      if (context < 0) throw mismatch(operation.path, index + 1, lines, [hunk.context], cursor)
      cursor = context + 1
    }
    let oldLines = hunk.oldLines
    let newLines = hunk.newLines
    let start = oldLines.length ? seek(lines, oldLines, cursor, hunk.endOfFile) : lines.length
    if (start < 0 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1)
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
      start = seek(lines, oldLines, cursor, hunk.endOfFile)
    }
    if (start < 0) throw mismatch(operation.path, index + 1, lines, hunk.oldLines, cursor)
    const context = new Map(hunk.contextLineIndices.map(([oldIndex, newIndex]) => [newIndex, oldIndex]))
    let oldPosition = 0
    const replacement = newLines.map((value, newIndex): SourceLine => {
      const oldIndex = context.get(newIndex)
      if (oldIndex !== undefined && oldIndex < oldLines.length) {
        oldPosition = oldIndex + 1
        return { ...lines[start + oldIndex]! }
      }
      const eol = lines[start + oldPosition]?.eol || lines[start + oldPosition - 1]?.eol || defaultEol
      if (oldPosition < oldLines.length) oldPosition++
      return { text: value, eol }
    })
    replacements.push({ start, count: oldLines.length, lines: replacement })
    if (oldLines.length) cursor = start + oldLines.length
  }
  const result = [...lines]
  replacements.sort((a, b) => a.start - b.start)
  for (const replacement of replacements.toReversed()) {
    result.splice(replacement.start, replacement.count, ...replacement.lines)
  }
  // Insertion after an unterminated line needs a separator, but not a final newline.
  for (let i = 0; i < result.length - 1; i++) {
    if (!result[i]!.eol) result[i] = { ...result[i]!, eol: defaultEol }
  }
  if (result.length) {
    const last = result.length - 1
    result[last] = {
      ...result[last]!,
      eol: lines.length ? (lines.at(-1)!.eol ? result[last]!.eol || defaultEol : "") : defaultEol,
    }
  }
  return result.map((line) => line.text + line.eol).join("")
}
