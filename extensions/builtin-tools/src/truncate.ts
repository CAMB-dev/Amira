import { randomBytes } from "node:crypto"
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ArtifactInfo,
  countLines,
  DEFAULT_PREVIEW_CHARS,
  DEFAULT_SAVE_ABOVE,
  MAX_ARTIFACT_CHARS,
  type OutputLimits,
  type OutputStore,
  outputPreview,
  outputSize,
  type SaveOutputOptions,
  type ToolContext,
} from "@amira/api"

const KEEP_OUTPUT_MS = 24 * 60 * 60 * 1000

/**
 * Most characters a tool that pages its own output (job_output) returns per call: under the
 * default size limit for large outputs, so a page is not saved as an artifact again.
 */
export const MAX_OUTPUT_CHARS = DEFAULT_SAVE_ABOVE - 1000

/**
 * The note older versions left where they cut oversized output; frontends still show it
 * shorter in sessions saved then. The groups: the lines left out, and where the full output is.
 */
export const TRUNCATION_NOTE =
  /^\[\.\.\. \d+ characters \((\d+) lines\) omitted\. (?:Full output saved to (.+?) — use the read tool.*|The full output could not be saved.*) \.\.\.\]$/

export function toolOutputDir(): string {
  return join(tmpdir(), "amira", "tool-output")
}

/**
 * Where tools save large outputs when the host gives them no artifact store (ToolSession.outputs),
 * e.g. when they run outside an agent: the system's temp directory, swept of files older than a
 * day once per process.
 */
export class TempOutputStore implements OutputStore {
  readonly limits: OutputLimits
  readonly #known = new Map<string, ArtifactInfo>()

  constructor(
    readonly dir = toolOutputDir(),
    limits: Partial<OutputLimits> = {},
  ) {
    this.limits = {
      saveAbove: limits.saveAbove ?? DEFAULT_SAVE_ABOVE,
      previewChars: limits.previewChars ?? DEFAULT_PREVIEW_CHARS,
    }
  }

  async save(opts: SaveOutputOptions): Promise<ArtifactInfo> {
    await mkdir(this.dir, { recursive: true })
    sweepOnce(this.dir)
    const text = opts.text.length > MAX_ARTIFACT_CHARS ? opts.text.slice(0, MAX_ARTIFACT_CHARS) : opts.text
    const incomplete =
      opts.incomplete ?? (text.length < opts.text.length ? "only the first part was saved" : undefined)
    const id = `a_${randomBytes(5).toString("hex")}`
    const path = join(this.dir, `${id}.txt`)
    await writeFile(`${path}.tmp`, text)
    await rename(`${path}.tmp`, path)
    const info: ArtifactInfo = {
      id,
      path,
      tool: opts.tool,
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      sessionId: "",
      chars: text.length,
      lines: countLines(text),
      bytes: Buffer.byteLength(text),
      complete: incomplete === undefined,
      ...(incomplete !== undefined ? { incomplete } : {}),
      createdAt: new Date().toISOString(),
    }
    this.#known.set(id, info)
    return info
  }

  find(id: string): ArtifactInfo | undefined {
    return this.#known.get(id)
  }
}

let fallback: TempOutputStore | undefined

/** The artifact store a tool call saves to: its session's, or the temp directory's. */
export function outputStore(ctx: ToolContext): OutputStore {
  if (ctx.session?.outputs) return ctx.session.outputs
  fallback ??= new TempOutputStore()
  return fallback
}

/** The sizes a tool call's output is measured against. */
export function outputLimits(ctx: ToolContext): OutputLimits {
  return outputStore(ctx).limits
}

export interface KeptOutput {
  /** What the model gets: the output, or a preview of it. */
  text: string
  /** Where the whole output was saved, when it was too long. */
  artifact?: ArtifactInfo
}

export interface KeepOutputOptions {
  /** The whole output. */
  text: string
  /**
   * What the preview is cut from when the output is saved: by default the whole output, for a
   * tool that limits its results the ones it shows.
   */
  shown?: string
  tool: string
  /** Facts for the preview's header, e.g. how many results there are. */
  facts?: string[]
  /** Why the output is not all the tool produced, if it is not. */
  incomplete?: string
  /** Store to use instead of the call's (tests). */
  store?: OutputStore
}

/**
 * A1: output over the size limit is saved whole as an artifact, and the model gets a preview
 * with its id and how to read on; output under it is returned as it is (`shown` when given).
 * When saving fails the preview says so and names no artifact.
 */
export async function keepOutput(ctx: ToolContext, o: KeepOutputOptions): Promise<KeptOutput> {
  const store = o.store ?? outputStore(ctx)
  const { saveAbove, previewChars } = store.limits
  if (outputSize(o.text) <= saveAbove) return { text: o.shown ?? o.text }
  let artifact: ArtifactInfo | undefined
  let saveError: string | undefined
  try {
    artifact = await store.save({
      text: o.text,
      tool: o.tool,
      toolCallId: ctx.toolCallId,
      ...(o.incomplete !== undefined ? { incomplete: o.incomplete } : {}),
    })
  } catch (err) {
    saveError = (err as Error).message
  }
  const text = outputPreview({
    text: o.shown ?? o.text,
    ...(o.facts ? { facts: o.facts } : {}),
    ...(artifact ? { artifact } : {}),
    ...(saveError ? { saveError, total: { chars: o.text.length, lines: countLines(o.text) } } : {}),
    previewChars,
  })
  return { text, ...(artifact ? { artifact } : {}) }
}

const swept = new Set<string>()

/** Deletes saved outputs older than a day, once per directory per process. Best effort, not awaited. */
function sweepOnce(dir: string): void {
  if (swept.has(dir)) return
  swept.add(dir)
  const cutoff = Date.now() - KEEP_OUTPUT_MS
  void (async () => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name)
      try {
        const st = await stat(path)
        if (st.isFile() && st.mtimeMs < cutoff) await rm(path, { force: true })
      } catch {}
    }
  })().catch(() => {})
}
