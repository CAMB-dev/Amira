import {
  type ApplyPatchDetails,
  type BackgroundJobDetails,
  type BashDetails,
  diffToolLines,
  type EditDetails,
  type GlobDetails,
  type GrepDetails,
  plural,
  type ReadDetails,
  type ToolCallView,
  type ToolLine,
  type ToolPresenter,
  type WriteDetails,
} from "@amira/api"
import type { ApplyPatchParams } from "./apply-patch.ts"
import { askUserPresenter } from "./ask-user.ts"
import type { BashParams } from "./bash.ts"
import { fileDiff } from "./diff.ts"
import type { EditParams } from "./edit.ts"
import type { GlobParams } from "./glob.ts"
import type { GrepParams } from "./grep.ts"
import { jobListPresenter, jobOutputPresenter, jobStopPresenter } from "./jobs-ui.ts"
import type { ReadParams } from "./read.ts"
import { NOT_CONTAINED_WARNING, OUTPUT_OPEN_NOTE, STATUS_LINE } from "./shell-notes.ts"
import { TRUNCATION_NOTE } from "./truncate.ts"
import type { WriteParams } from "./write.ts"

/** How the built-in tools are shown (D1, D27): through the same API as any extension's. */

const str = (v: unknown) => (typeof v === "string" ? v : "")

/** Last output lines a command that worked shows when the frontend does not say: as many as while it ran. */
const SHELL_TAIL_LINES = 3

/** The first line of a text, marked when more follow. */
function firstLine(s: string): string {
  const lines = s.trim().split("\n")
  return lines.length > 1 ? `${lines[0]!.trim()} …` : (lines[0] ?? "").trim()
}

/**
 * Output as presenter lines; the note the tool puts where it cut oversized output (meant for
 * the model) as a short muted line saying how much was left out and where all of it is.
 */
const outputLines = (text: string): ToolLine[] =>
  text
    ? text.split("\n").map((t) => {
        const cut = TRUNCATION_NOTE.exec(t)
        if (!cut) return { kind: "code", text: t }
        const where = cut[2] ? ` ${"·"} full output: ${cut[2]}` : ""
        return { kind: "muted", text: `… ${plural(Number(cut[1]), "line")} omitted${where}` }
      })
    : []

/** A call's details, when they are there and of the right shape (they are not after a resume). */
function detailsOf<D>(call: ToolCallView<any, unknown>, key: keyof D): D | undefined {
  const d = call.result.details
  return d && typeof d === "object" && key in d ? (d as D) : undefined
}

/** "+3 -1": the signs the diff lines under it carry. */
const changeCount = (added: number, removed: number) => `+${added} -${removed}`

/** Numbered file content as read returns it: "    12\tcode". */
function readLines(text: string): ToolLine[] {
  const out: ToolLine[] = []
  for (const l of text.split("\n")) {
    const m = /^\s*(\d+)\t(.*)$/.exec(l)
    if (m) out.push({ kind: "code", text: m[2]!, lineNo: Number(m[1]) })
  }
  return out
}

/** The lines a read asked for, as its head says them: "lines 50–69", "from line 50", "lines 1–20". */
function readRange(args: ReadParams): string | undefined {
  const start = Number.isInteger(args.offset) ? args.offset! : undefined
  const count = Number.isInteger(args.limit) ? args.limit! : undefined
  if (start === undefined && count === undefined) return undefined
  const from = start ?? 1
  return count !== undefined ? `lines ${from}–${from + count - 1}` : `from line ${from}`
}

export const readPresenter: ToolPresenter<ReadParams, ReadDetails> = {
  summary(args) {
    const range = readRange(args)
    return range ? `${str(args.path)} · ${range}` : str(args.path)
  },
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<ReadDetails>(call, "path")
    if (d?.mimeType) return `image · ${Math.max(1, Math.round((d.bytes ?? 0) / 1024))} KB`
    const lines = d?.lines ?? readLines(call.text).length
    if (lines === 0) return firstLine(call.text).replace(/^\((.*)\)$/, "$1")
    const start = d?.startLine ?? 1
    const whole = d?.totalLines !== undefined && start === 1 && lines === d.totalLines
    if (whole || !d) return plural(lines, "line")
    const of = d.totalLines !== undefined ? ` of ${d.totalLines}` : ""
    // The head says which lines were asked for; the result how many came, of how many.
    if (readRange(call.args)) return `${plural(lines, "line")}${of}`
    return `${plural(lines, "line")} (${start}–${start + lines - 1}${of})`
  },
  body: (call, { detail }) => (detail === "full" && !call.result.isError ? readLines(call.text) : []),
  explore: (args) => ({ verb: "Read", target: str(args.path) }),
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

export const applyPatchPresenter: ToolPresenter<ApplyPatchParams, ApplyPatchDetails> = {
  // The headers alone name the files, whether or not the rest of the patch parses.
  summary: (args) =>
    [...str(args.patch).matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+?)\s*$/gm)]
      .map((m) => m[1])
      .join(", ") || "patch",
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<ApplyPatchDetails>(call, "files")
    if (!d) return firstLine(call.text)
    return `${plural(d.files.length, "file")} · ${changeCount(
      d.files.reduce((n, f) => n + f.added, 0),
      d.files.reduce((n, f) => n + f.removed, 0),
    )}`
  },
  body(call) {
    if (call.result.isError) return []
    const d = detailsOf<ApplyPatchDetails>(call, "files")
    if (d)
      return d.files.flatMap((file): ToolLine[] => [
        { kind: "muted", text: `${file.action}: ${file.from ? `${file.from} → ` : ""}${file.path}` },
        ...diffToolLines(file.hunks),
        ...(file.truncated ? [{ kind: "muted" as const, text: "… diff truncated" }] : []),
      ])
    // Details are not persisted: render the supplied patch without inventing line numbers.
    return str(call.args.patch)
      .split(/\r?\n/)
      .map(
        (line): ToolLine => ({
          kind: line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "muted",
          text: /^[+\- ]/.test(line) ? line.slice(1) : line,
        }),
      )
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

/** What a background start printed: the "Output so far" paragraph, or the output before its end. */
function backgroundOutput(text: string, d: BackgroundJobDetails): string {
  const parts = text.split("\n\n")
  if (parts[0]?.startsWith("Shell: ")) parts.shift()
  const head = "Output so far:\n"
  const so = parts.find((p) => p.startsWith(head))
  if (so) return so.slice(head.length)
  if (d.status === "running" || d.status === "starting") return ""
  // It ended at once: the output, then the sentence saying how it ended.
  return parts
    .slice(0, -1)
    .join("\n\n")
    .replace(/^\(no output\)$/, "")
}

export const shellPresenter: ToolPresenter<BashParams, BashDetails | BackgroundJobDetails> = {
  summary: (args) => `${firstLine(str(args.command))}${args.background === true ? " · background" : ""}`,
  result(call) {
    const job = detailsOf<BackgroundJobDetails>(call, "jobId")
    if (job) {
      if (job.status === "running" || job.status === "starting") return `started ${job.jobId}`
      if (job.status === "failed") return `${job.jobId} failed to start`
      return `${job.jobId} ended at once · exit ${job.exitCode ?? "killed"}`
    }
    const d = detailsOf<BashDetails>(call, "exitCode")
    const lines = d?.outputLines ?? shellOutput(call.text).split("\n").filter(Boolean).length
    const printed = lines ? ` · ${plural(lines, "line")}` : " · no output"
    if (d?.timedOut) return `timed out${printed}`
    if (d?.aborted) return `interrupted${printed}`
    if (d && d.exitCode === null) return `killed${printed}`
    const code = d?.exitCode ?? Number(/Exit code: (-?\d+)/.exec(call.text)?.[1] ?? Number.NaN)
    if (Number.isNaN(code)) return undefined
    // Success is the rule: only another exit code is worth saying.
    if (code === 0) return lines ? plural(lines, "line") : "no output"
    return `exit ${code}${printed}`
  },
  body(call, { detail, outputLines: tail = SHELL_TAIL_LINES }) {
    const job = detailsOf<BackgroundJobDetails>(call, "jobId")
    const out = outputLines(job ? backgroundOutput(call.text, job) : shellOutput(call.text))
    if (call.result.isError || detail === "full") return out
    // A command that worked shows the end of what it printed, as it did while it ran.
    if (detail !== "summary" || tail <= 0) return []
    while (out.length && !out.at(-1)!.text.trim()) out.pop()
    if (out.length <= tail) return out
    return [{ kind: "muted", text: `… ${plural(out.length - tail, "earlier line")}` }, ...out.slice(-tail)]
  },
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
  explore: (args) => ({
    verb: "Search",
    target: `${str(args.pattern)}${args.path ? ` in ${str(args.path)}` : ""}`,
  }),
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
  explore: (args) => ({
    verb: "List",
    target: `${str(args.pattern)}${args.path ? ` in ${str(args.path)}` : ""}`,
  }),
}

/** The presenters of the built-in tools, by tool name. */
export const builtinPresenters: Record<string, ToolPresenter<any, any>> = {
  read: readPresenter,
  write: writePresenter,
  edit: editPresenter,
  apply_patch: applyPatchPresenter,
  bash: shellPresenter,
  powershell: shellPresenter,
  grep: grepPresenter,
  glob: globPresenter,
  ask_user: askUserPresenter,
  job_output: jobOutputPresenter,
  job_stop: jobStopPresenter,
  job_list: jobListPresenter,
}
