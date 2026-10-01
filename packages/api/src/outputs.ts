/**
 * Large tool outputs (context management, A1): an output over a size limit is saved whole as an
 * artifact of the session, and the model gets a bounded preview that says where the rest is and
 * how to read it (the output_read tool, or read on the artifact's file).
 */

import type { ToolLine } from "./tool-renderers.ts"

/** Characters of tool output over which it is saved as an artifact (settings context.outputs.saveAbove). */
export const DEFAULT_SAVE_ABOVE = 16_000
/** Most characters of the preview the model gets instead (settings context.outputs.previewChars). */
export const DEFAULT_PREVIEW_CHARS = 8_000
/** Most characters one artifact captures; longer output is saved cut, marked incomplete. */
export const MAX_ARTIFACT_CHARS = 16 * 1024 * 1024

/** A saved tool output. */
export interface ArtifactInfo {
  /** "a_" and hex digits; stable for the session's life. */
  id: string
  /** The artifact's text file: read can open it too. */
  path: string
  /** The tool whose output it is. */
  tool: string
  toolCallId?: string
  /** The session that saved it. */
  sessionId: string
  /** Characters and lines of the saved text. */
  chars: number
  lines: number
  bytes: number
  /** False when the output was cut before saving (`incomplete` says why). */
  complete: boolean
  incomplete?: string
  createdAt: string
  /** When /prune deleted its text; the metadata stays so reading it says so. */
  pruned?: string
}

export interface SaveOutputOptions {
  text: string
  tool: string
  toolCallId?: string
  /** Why the text is not all the tool produced (a size cap, an abort), if it is not. */
  incomplete?: string
}

/** The sizes large outputs are measured against. */
export interface OutputLimits {
  saveAbove: number
  previewChars: number
}

/**
 * A session's artifacts (ToolSession.outputs). Saving throws when the artifact cannot be
 * written (a failing disk, the session's quota): the tool then gives the model a preview that
 * says so, never a reference to nothing.
 */
export interface OutputStore {
  readonly limits: OutputLimits
  save(opts: SaveOutputOptions): Promise<ArtifactInfo>
  /** An artifact by id: this session's, or one of the sessions it was started from. */
  find(id: string): ArtifactInfo | undefined
}

export interface PreviewOptions {
  /**
   * What the preview is cut from: the whole output, or for a tool that limits how many results
   * it shows (grep's head_limit) the part it would show. Line numbers in the preview count in it.
   */
  text: string
  /** Facts the tool knows, e.g. "exit code 1" or "showing 250 of 4,120 results". */
  facts?: string[]
  /** Where the whole output was saved. */
  artifact?: ArtifactInfo
  /** Why it could not be saved, when it was not. */
  saveError?: string
  /** Size of the whole output, when `text` is only part of it and nothing was saved. */
  total?: { chars: number; lines: number }
  previewChars: number
}

const n = (x: number) => x.toLocaleString("en-US")

/** Lines of a text as editors count them: a final line break does not start another line. */
export function countLines(text: string): number {
  if (text === "") return 0
  const breaks = text.split("\n").length - 1
  return text.endsWith("\n") ? breaks : breaks + 1
}

/** The first line of a preview: what was saved, where, and how to read more. */
function previewHeader(o: PreviewOptions, firstOmitted: number | undefined): string {
  const facts = o.facts?.length ? ` ${o.facts.join("; ")}.` : ""
  const a = o.artifact
  if (a) {
    const cut = a.complete ? "" : `; capture incomplete: ${a.incomplete ?? "cut short"}`
    const from = firstOmitted ?? 1
    return (
      `[Output saved as artifact ${a.id}: ${n(a.chars)} characters, ${n(a.lines)} lines${cut}.${facts} ` +
      `Read more with output_read({"id":"${a.id}","offset":${from},"limit":200}) or search it with ` +
      `output_read({"id":"${a.id}","grep":"<regex>"}); the file is ${a.path}]`
    )
  }
  const size = o.total ?? { chars: o.text.length, lines: countLines(o.text) }
  return `[Output too long: ${n(size.chars)} characters, ${n(size.lines)} lines. It could not be saved (${o.saveError ?? "no artifact store"}), so only this preview is available.${facts}]`
}

/**
 * The preview the model gets for a large output: a header line first (so a transcript that
 * clips long blocks still keeps the reference), then the head and the tail of `text` in whole
 * lines where possible, with a note where lines were left out. At most about `previewChars`.
 */
export function outputPreview(o: PreviewOptions): string {
  const text = o.text.replace(/\r\n/g, "\n")
  // Measure with the longest header the result can have.
  const header = previewHeader(o, countLines(text) || 1)
  const budget = Math.max(200, o.previewChars - header.length - 120)
  if (text.length <= budget) return `${previewHeader(o, undefined)}\n${text}`
  const half = Math.floor(budget / 2)
  let head = text.slice(0, half)
  const headCut = head.lastIndexOf("\n")
  if (headCut > half / 2) head = head.slice(0, headCut + 1)
  let tail = text.slice(text.length - half)
  const tailCut = tail.indexOf("\n")
  if (tailCut !== -1 && tailCut < half / 2) tail = tail.slice(tailCut + 1)
  // Never split a surrogate pair at either cut.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
  const omitted = text.slice(head.length, text.length - tail.length)
  const headLines = head.split("\n").length - 1
  const first = headLines + 1
  const omittedLines = Math.max(1, omitted.split("\n").length - (omitted.endsWith("\n") ? 1 : 0))
  const last = first + omittedLines - 1
  const note = `[... ${n(omittedLines)} lines (${n(omitted.length)} characters) omitted: lines ${first}-${last} ...]`
  return `${previewHeader(o, first)}\n${head}${head.endsWith("\n") ? "" : "\n"}${note}\n${tail}`
}

/** The header line of a saved output's preview; groups: id, characters, lines. */
export const ARTIFACT_HEADER =
  /^\[Output saved as artifact (a_[0-9a-f]+): ([\d,]+) characters, ([\d,]+) lines/
/** The header line of a preview whose output could not be saved; groups: characters, lines. */
export const UNSAVED_HEADER = /^\[Output too long: ([\d,]+) characters, ([\d,]+) lines\./
/** The note where a preview left lines out; groups: lines, characters, first, last. */
export const OMITTED_NOTE =
  /^\[\.\.\. ([\d,]+) lines \(([\d,]+) characters\) omitted: lines (\d+)-(\d+) \.\.\.\]$/

/** The artifact a tool result's text was saved as, from its preview header. */
export function artifactIdOf(text: string): string | undefined {
  return ARTIFACT_HEADER.exec(text.slice(0, 200))?.[1]
}

/**
 * A preview's own lines (its header and the note where it left lines out) as frontends show
 * them: short muted lines. Undefined for any other line.
 */
export function previewNoteLine(line: string): ToolLine | undefined {
  const saved = ARTIFACT_HEADER.exec(line)
  if (saved)
    return { kind: "muted", text: `… output saved as ${saved[1]} · ${saved[3]} lines · ${saved[2]} chars` }
  const unsaved = UNSAVED_HEADER.exec(line)
  if (unsaved)
    return { kind: "muted", text: `… output too long (${unsaved[2]} lines); only a preview was kept` }
  const cut = OMITTED_NOTE.exec(line)
  if (cut) return { kind: "muted", text: `… ${cut[1]} lines omitted (${cut[3]}–${cut[4]})` }
  return undefined
}
