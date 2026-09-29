import type {
  ImageInput,
  ImageOpenContext,
  ImageProvider,
  MarkdownNode,
  MarkdownRenderContext,
  MarkdownRendererDefinition,
  MarkdownRenderResult,
  OpenedImage,
  ViewLine,
} from "@amira/api"

/** Reports a failure of an extension's registration (extension.error). */
type Report = (source: string, error: string) => void

interface RendererEntry {
  def: MarkdownRendererDefinition
  source: string
  seq: number
  /** Lowercased languages, for code renderers. */
  langs?: Set<string>
  reported: boolean
}

const DEFAULT_WAIT_MS = 3000
const MAX_WAIT_MS = 15_000
/** Rows a rendering may take: more are cut (and reported), so a runaway one cannot flood the transcript. */
const MAX_LINES = 2000

const KINDS = new Set<ViewLine["kind"]>([
  "text",
  "muted",
  "accent",
  "success",
  "warning",
  "error",
  "code",
  "diff-add",
  "diff-remove",
  "diff-context",
  "diff-hunk",
])

/** Escape sequences: CSI, OSC, DCS/APC/PM/SOS strings, two-character ones. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P_^X][^\x1b]*(?:\x1b\\)?|.)?/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * Markdown renderers registered by extensions (D88, experimental). Frontends ask `render` for a
 * node once it is complete: the renderers that match it are asked highest priority first (equal
 * ones in registration order) until one returns a result; one that throws or rejects is
 * reported once and passed over. Results are checked: lines keep only known kinds and plain
 * text (escape sequences and control characters removed, one row per line).
 */
export class MarkdownRendererRegistry {
  #entries: RendererEntry[] = []
  #seq = 0
  #version = 0

  constructor(private readonly report: Report = () => {}) {}

  /** Throws for a renderer without an id, a match or a render function, or an id taken by its source. */
  register(def: MarkdownRendererDefinition, source = "host"): () => void {
    if (!def || typeof def.id !== "string" || !def.id.trim())
      throw new Error("a markdown renderer needs an id")
    if (typeof def.render !== "function")
      throw new Error(`markdown renderer "${def.id}" needs a render function`)
    const match = def.match as { image?: unknown; codeLang?: unknown } | undefined
    let langs: Set<string> | undefined
    if (match?.image === true) langs = undefined
    else if (Array.isArray(match?.codeLang) && match.codeLang.every((l) => typeof l === "string" && l.trim()))
      langs = new Set(match.codeLang.map((l: string) => l.trim().toLowerCase()))
    else throw new Error(`markdown renderer "${def.id}" needs match: { image: true } or { codeLang: [...] }`)
    if (this.#entries.some((e) => e.source === source && e.def.id === def.id))
      throw new Error(`markdown renderer "${def.id}" is already registered`)
    const entry: RendererEntry = {
      def,
      source,
      seq: this.#seq++,
      reported: false,
      ...(langs ? { langs } : {}),
    }
    this.#entries.push(entry)
    this.#entries.sort((a, b) => (b.def.priority ?? 0) - (a.def.priority ?? 0) || a.seq - b.seq)
    this.#version++
    return () => {
      const at = this.#entries.indexOf(entry)
      if (at === -1) return
      this.#entries.splice(at, 1)
      this.#version++
    }
  }

  get size(): number {
    return this.#entries.length
  }

  /** Bumped whenever a renderer comes or goes, so what was rendered before can be redone. */
  get version(): number {
    return this.#version
  }

  /** Whether a code block in `lang` is rendered by an extension: it is held until it closes. */
  claimsCode(lang: string): boolean {
    const l = lang.trim().toLowerCase()
    return !!l && this.#entries.some((e) => e.langs?.has(l))
  }

  /** Whether standalone images are rendered by an extension. */
  get claimsImages(): boolean {
    return this.#entries.some((e) => !e.langs)
  }

  /** How long the inline transcript waits for the node's async result: the longest its renderers ask. */
  waitMs(node: MarkdownNode): number {
    const asked = this.#matching(node).map((e) => {
      const ms = e.def.waitMs
      return typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, ms) : DEFAULT_WAIT_MS
    })
    return asked.length ? Math.min(MAX_WAIT_MS, Math.max(...asked)) : DEFAULT_WAIT_MS
  }

  /**
   * Renders `node` with the first renderer that returns a result: synchronously when the
   * renderers asked were, else a promise (which never rejects). Undefined when none did.
   */
  render(
    node: MarkdownNode,
    ctx: MarkdownRenderContext,
  ): MarkdownRenderResult | undefined | Promise<MarkdownRenderResult | undefined> {
    return this.#from(this.#matching(node), 0, node, ctx)
  }

  #matching(node: MarkdownNode): RendererEntry[] {
    if (node.type === "image") return this.#entries.filter((e) => !e.langs)
    const lang = node.lang.trim().toLowerCase()
    return lang ? this.#entries.filter((e) => e.langs?.has(lang)) : []
  }

  #from(
    list: RendererEntry[],
    start: number,
    node: MarkdownNode,
    ctx: MarkdownRenderContext,
  ): MarkdownRenderResult | undefined | Promise<MarkdownRenderResult | undefined> {
    for (let i = start; i < list.length; i++) {
      const entry = list[i]!
      let out: unknown
      try {
        out = entry.def.render(copyNode(node), { ...ctx })
      } catch (err) {
        this.#fail(entry, err)
        continue
      }
      if (out && typeof (out as Promise<unknown>).then === "function") {
        return (out as Promise<unknown>).then(
          (value) => this.#checked(entry, value) ?? this.#from(list, i + 1, node, ctx),
          (err) => {
            this.#fail(entry, err)
            return this.#from(list, i + 1, node, ctx)
          },
        )
      }
      const result = this.#checked(entry, out)
      if (result) return result
    }
    return undefined
  }

  /** The result as frontends get it, or undefined for none (or one that is not a result). */
  #checked(entry: RendererEntry, value: unknown): MarkdownRenderResult | undefined {
    if (value === undefined || value === null) return undefined
    const v = value as { lines?: unknown; image?: unknown }
    if (Array.isArray(v.lines)) {
      const lines: ViewLine[] = []
      for (const raw of v.lines as unknown[]) {
        const l = (raw ?? {}) as { kind?: unknown; text?: unknown }
        const kind = KINDS.has(l.kind as ViewLine["kind"]) ? (l.kind as ViewLine["kind"]) : "text"
        const text = String(l.text ?? "")
          .replace(/\r\n?/g, "\n")
          .replace(/\t/g, "  ")
        for (const row of text.split("\n"))
          lines.push({ kind, text: row.replace(ESCAPES, "").replace(CONTROLS, "") })
        if (lines.length > MAX_LINES) break
      }
      if (lines.length > MAX_LINES) {
        this.#fail(entry, new Error(`render returned more than ${MAX_LINES} lines; the rest were left out`))
        lines.length = MAX_LINES
      }
      return { lines }
    }
    const image = v.image as { url?: unknown; data?: unknown; mimeType?: unknown } | undefined
    if (image && typeof image.url === "string" && image.url) return { image: { url: image.url } }
    if (image && image.data instanceof Uint8Array)
      return {
        image: {
          data: image.data,
          ...(typeof image.mimeType === "string" ? { mimeType: image.mimeType } : {}),
        },
      }
    this.#fail(entry, new Error("render returned neither { lines } nor { image }"))
    return undefined
  }

  #fail(entry: RendererEntry, err: unknown) {
    if (entry.reported) return
    entry.reported = true
    this.report(
      entry.source,
      `markdown renderer "${entry.def.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Each renderer gets its own copy, so none can change what the next one sees. */
function copyNode(node: MarkdownNode): MarkdownNode {
  return { ...node }
}

interface ProviderEntry {
  provider: ImageProvider
  source: string
  seq: number
}

/**
 * Image providers registered by extensions (D88, experimental): `open` asks them highest
 * priority first until one opens the image. A provider's failure to open an image (a missing
 * file, a 404) only means the next one is asked; in the end the image is its alt text.
 */
export class ImageProviderRegistry {
  #entries: ProviderEntry[] = []
  #seq = 0

  /** Throws for a provider without an id or an open function. */
  register(provider: ImageProvider, source = "host"): () => void {
    if (!provider || typeof provider.id !== "string" || !provider.id.trim())
      throw new Error("an image provider needs an id")
    if (typeof provider.open !== "function")
      throw new Error(`image provider "${provider.id}" needs an open function`)
    const entry = { provider, source, seq: this.#seq++ }
    this.#entries.push(entry)
    this.#entries.sort((a, b) => (b.provider.priority ?? 0) - (a.provider.priority ?? 0) || a.seq - b.seq)
    return () => {
      const at = this.#entries.indexOf(entry)
      if (at !== -1) this.#entries.splice(at, 1)
    }
  }

  get size(): number {
    return this.#entries.length
  }

  /** The image opened by the first provider that can; undefined when none can (never rejects). */
  async open(input: ImageInput, ctx: ImageOpenContext): Promise<OpenedImage | undefined> {
    for (const { provider } of [...this.#entries]) {
      if (ctx.signal.aborted) return undefined
      try {
        const opened = await provider.open(input, ctx)
        if (
          opened &&
          typeof opened.encode === "function" &&
          Number.isFinite(opened.width) &&
          Number.isFinite(opened.height) &&
          opened.width >= 1 &&
          opened.height >= 1
        )
          return opened
      } catch {
        // Not one it can show, or not there: the next provider may.
      }
    }
    return undefined
  }
}

/**
 * Services extensions offer each other (D88, experimental). A name is offered by one extension
 * at a time: offering a taken name throws; the offer ends when its extension unloads.
 */
export class ServiceRegistry {
  #services = new Map<string, { service: unknown; source: string }>()

  provide(name: string, service: unknown, source = "host"): () => void {
    if (typeof name !== "string" || !name.trim()) throw new Error("a service needs a name")
    if (service === undefined || service === null) throw new Error(`service "${name}" needs a value`)
    const taken = this.#services.get(name)
    if (taken) throw new Error(`service "${name}" is already offered by ${taken.source}`)
    const entry = { service, source }
    this.#services.set(name, entry)
    return () => {
      if (this.#services.get(name) === entry) this.#services.delete(name)
    }
  }

  get(name: string): unknown {
    return this.#services.get(name)?.service
  }

  get names(): string[] {
    return [...this.#services.keys()]
  }
}
