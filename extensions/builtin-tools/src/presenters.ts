import {
  type BashDetails,
  diffToolLines,
  type EditDetails,
  type GlobDetails,
  type GrepDetails,
  type ReadDetails,
  type ToolCallView,
  type ToolLine,
  type ToolPresenter,
  type WriteDetails,
} from "@amira/api"
import { askUserPresenter } from "./ask-user.ts"
import type { BashParams } from "./bash.ts"
import { fileDiff } from "./diff.ts"
import type { EditParams } from "./edit.ts"
import type { GlobParams } from "./glob.ts"
import type { GrepParams } from "./grep.ts"
import type { ReadParams } from "./read.ts"
import { NOT_CONTAINED_WARNING, OUTPUT_OPEN_NOTE, STATUS_LINE } from "./shell-notes.ts"
import type { WriteParams } from "./write.ts"

/** How the built-in tools are shown (D1, D27): through the same API as any extension's. */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const str = (v: unknown) => (typeof v === "string" ? v : "")

/** The first line of a text, marked when more follow. */
function firstLine(s: string): string {
  const lines = s.trim().split("\n")
  return lines.length > 1 ? `${lines[0]!.trim()} …` : (lines[0] ?? "").trim()
}

const outputLines = (text: string): ToolLine[] =>
  text ? text.split("\n").map((t) => ({ kind: "code", text: t })) : []

/** A call's details, when they are there and of the right shape (they are not after a resume). */
function detailsOf<D>(call: ToolCallView<any, unknown>, key: keyof D): D | undefined {
  const d = call.result.details
  return d && typeof d === "object" && key in d ? (d as D) : undefined
}

/** "+3 −1" */
const changeCount = (added: number, removed: number) => `+${added} −${removed}`

/** Numbered file content as read returns it: "    12\tcode". */
function readLines(text: string): ToolLine[] {
  const out: ToolLine[] = []
  for (const l of text.split("\n")) {
    const m = /^\s*(\d+)\t(.*)$/.exec(l)
    if (m) out.push({ kind: "code", text: m[2]!, lineNo: Number(m[1]) })
  }
  return out
}

export const readPresenter: ToolPresenter<ReadParams, ReadDetails> = {
  summary(args) {
    const path = str(args.path)
    const start = Number.isInteger(args.offset) ? args.offset! : undefined
    const count = Number.isInteger(args.limit) ? args.limit! : undefined
    if (start === undefined && count === undefined) return path
    const from = start ?? 1
    return `${path} · lines ${from}${count !== undefined ? `–${from + count - 1}` : "–"}`
  },
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<ReadDetails>(call, "path")
    if (d?.mimeType) return `image · ${Math.max(1, Math.round((d.bytes ?? 0) / 1024))} KB`
    const lines = d?.lines ?? readLines(call.text).length
    if (lines === 0) return firstLine(call.text).replace(/^\((.*)\)$/, "$1")
    const start = d?.startLine ?? 1
    const whole = d?.totalLines !== undefined && start === 1 && lines === d.totalLines
    const range =
      !whole && d
        ? ` (${start}–${start + lines - 1}${d.totalLines !== undefined ? ` of ${d.totalLines}` : ""})`
        : ""
    return `${plural(lines, "line")}${range}`
  },
  body: (call, { detail }) => (detail === "full" && !call.result.isError ? readLines(call.text) : []),
}

/** The diff of an edit: from its details, or worked out from its arguments after a resume. */
function editDiff(call: ToolCallView<EditParams, EditDetails>) {
  const d = detailsOf<EditDetails>(call, "hunks")
  if (d) return { diff: d, lines: diffToolLines(d.hunks), replacements: d.replacements }
  // Without the file its line numbers are unknown; show the change alone.
  const diff = fileDiff(str(call.args.old_string), str(call.args.new_string), Number.POSITIVE_INFINITY)
  const lines = diffToolLines(diff.hunks).map(({ kind, text }) => ({ kind, text }))
  return { diff, lines, replacements: undefined }
}

export const editPresenter: ToolPresenter<EditParams, EditDetails> = {
  summary: (args) => `${str(args.path)}${args.replace_all ? " · all" : ""}`,
  result(call) {
    if (call.result.isError) return undefined
    const { diff, replacements } = editDiff(call)
    const n =
      replacements !== undefined && replacements > 1 ? ` · ${plural(replacements, "replacement")}` : ""
    return `${changeCount(diff.added, diff.removed)}${n}`
  },
  body: (call) => (call.result.isError ? [] : editDiff(call).lines),
}

export const writePresenter: ToolPresenter<WriteParams, WriteDetails> = {
  summary: (args) => str(args.path),
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<WriteDetails>(call, "hunks")
    if (!d) return undefined
    return d.created ? `created · ${plural(d.lines, "line")}` : changeCount(d.added, d.removed)
  },
  body(call) {
    if (call.result.isError) return []
    const d = detailsOf<WriteDetails>(call, "hunks")
    if (d) return diffToolLines(d.hunks)
    // After a resume: what was written, as additions.
    return str(call.args.content)
      .replace(/\n$/, "")
      .split("\n")
      .map((text, i) => ({ kind: "diff-add", text, lineNo: i + 1 }))
  },
}

/** A shell's output without the lines the tool adds around it (the shell label, the exit status). */
function shellOutput(text: string): string {
  const parts = text.split("\n\n")
  if (parts[0]?.startsWith("Shell: ")) parts.shift()
  // Only the tool's own paragraphs: output whose last paragraph starts with "Warning:" stays.
  while (parts.at(-1) === NOT_CONTAINED_WARNING || parts.at(-1) === OUTPUT_OPEN_NOTE) parts.pop()
  if (parts.length && STATUS_LINE.test(parts.at(-1)!)) parts.pop()
  const out = parts.join("\n\n")
  return out === "(no output)" ? "" : out
}

export const shellPresenter: ToolPresenter<BashParams, BashDetails> = {
  summary: (args) => firstLine(str(args.command)),
  result(call) {
    const d = detailsOf<BashDetails>(call, "exitCode")
    const lines = d?.outputLines ?? shellOutput(call.text).split("\n").filter(Boolean).length
    const printed = lines ? ` · ${plural(lines, "line")}` : " · no output"
    if (d?.timedOut) return `timed out${printed}`
    if (d?.aborted) return `interrupted${printed}`
    if (d && d.exitCode === null) return `killed${printed}`
    const code = d?.exitCode ?? Number(/Exit code: (\d+)/.exec(call.text)?.[1] ?? Number.NaN)
    if (Number.isNaN(code)) return undefined
    return `exit ${code}${printed}`
  },
  body: (call, { detail }) =>
    call.result.isError || detail === "full" ? outputLines(shellOutput(call.text)) : [],
}

export const grepPresenter: ToolPresenter<GrepParams, GrepDetails> = {
  summary(args) {
    const where = args.path ? ` in ${str(args.path)}` : ""
    const glob = args.glob ? ` · ${str(args.glob)}` : ""
    return `/${str(args.pattern)}/${args.ignore_case ? "i" : ""}${where}${glob}`
  },
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<GrepDetails>(call, "matchedFiles")
    if (!d) return call.text.startsWith("No matches") ? "no matches" : undefined
    const files = plural(d.matchedFiles, "file")
    return d.matches === undefined ? files : `${plural(d.matches, "match", "matches")} in ${files}`
  },
  body: (call, { detail }) => (detail === "full" ? outputLines(call.text) : []),
}

export const globPresenter: ToolPresenter<GlobParams, GlobDetails> = {
  summary: (args) => `${str(args.pattern)}${args.path ? ` in ${str(args.path)}` : ""}`,
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<GlobDetails>(call, "count")
    if (d) return plural(d.count, "file")
    return call.text.startsWith("No files") ? "no files" : plural(call.text.split("\n").length, "file")
  },
  body: (call, { detail }) => (detail === "full" ? outputLines(call.text) : []),
}

/** The presenters of the built-in tools, by tool name. */
export const builtinPresenters: Record<string, ToolPresenter<any, any>> = {
  read: readPresenter,
  write: writePresenter,
  edit: editPresenter,
  bash: shellPresenter,
  powershell: shellPresenter,
  grep: grepPresenter,
  glob: globPresenter,
  ask_user: askUserPresenter,
}
