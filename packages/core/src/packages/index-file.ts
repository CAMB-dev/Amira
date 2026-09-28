import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { amiraHome } from "../home.ts"
import type { PackageSource } from "./lock.ts"
import { isValidPackageName, PackageError } from "./manifest.ts"

/** The official extensions index (D49): index.json on the default branch of amira-extensions. */
export const DEFAULT_INDEX_URL = "https://raw.githubusercontent.com/CAMB-dev/amira-extensions/HEAD/index.json"
const HOUR_MS = 60 * 60 * 1000

/**
 * index.json, version 1:
 * `{ "schemaVersion": 1, "extensions": [IndexEntry, ...] }`. Unknown keys are ignored, so
 * later versions can add fields; an entry that does not fit is skipped with a warning.
 */
export interface ExtensionIndex {
  schemaVersion: 1
  extensions: IndexEntry[]
}

export interface IndexEntry {
  /** The name `amira ext install <name>` takes; also the package's own name. */
  name: string
  description: string
  /** The version the source currently holds; informational, the install pins the real one. */
  version: string
  /** `{ "git": url, "path"?: subdirectory, "ref"?: branch, tag or commit }` or `{ "npm": spec }`. */
  source: PackageSource
  /** Semver range of the extension API the extension needs, like `engines.amira`. */
  engine?: string
  tags: string[]
  homepage?: string
}

export interface IndexOptions {
  /** An http(s) URL or a local file. Default $AMIRA_EXTENSIONS_INDEX, then DEFAULT_INDEX_URL. */
  url?: string
  /** Default ~/.amira/cache/extensions-index.json. */
  cacheFile?: string
  /** How long a cached copy is used without asking the network. Default 1 h. */
  ttlMs?: number
  /** Ignore a fresh cache. */
  refresh?: boolean
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

export interface LoadedIndex {
  url: string
  index: ExtensionIndex
  /** Entries that were skipped, and why the cache was used when the download failed. */
  warnings: string[]
}

export function indexUrl(opts: IndexOptions = {}, env = process.env): string {
  return opts.url ?? env.AMIRA_EXTENSIONS_INDEX ?? DEFAULT_INDEX_URL
}

interface CacheFile {
  fetchedAt: number
  url: string
  data: unknown
}

/**
 * The index, from the cache while it is fresh, else downloaded. Offline, a stale cache is
 * used with a warning; with no cache at all it throws.
 */
export async function loadIndex(opts: IndexOptions = {}): Promise<LoadedIndex> {
  const url = indexUrl(opts)
  if (!/^https?:\/\//.test(url)) {
    let text: string
    try {
      text = await readFile(url.startsWith("file://") ? fileURLToPath(url) : url, "utf8")
    } catch (err) {
      throw new PackageError(`cannot read the extensions index ${url}: ${message(err)}`)
    }
    return { url, ...parseIndex(parseJson(text, url)) }
  }
  const cacheFile = opts.cacheFile ?? path.join(amiraHome(), "cache", "extensions-index.json")
  const now = (opts.now ?? Date.now)()
  const cached = await readCache(cacheFile, url)
  const age = cached ? now - cached.fetchedAt : Number.POSITIVE_INFINITY
  if (cached && !opts.refresh && age >= 0 && age < (opts.ttlMs ?? HOUR_MS)) {
    return { url, ...parseIndex(cached.data) }
  }
  let data: unknown
  try {
    const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = parseJson(await res.text(), url)
    parseIndex(data)
  } catch (err) {
    if (!cached) throw new PackageError(`cannot download the extensions index ${url}: ${message(err)}`)
    const parsed = parseIndex(cached.data)
    const when = new Date(cached.fetchedAt).toISOString()
    parsed.warnings.unshift(
      `could not refresh the extensions index (${message(err)}); using the copy from ${when}`,
    )
    return { url, ...parsed }
  }
  await writeCache(cacheFile, { fetchedAt: now, url, data }).catch(() => {})
  return { url, ...parseIndex(data) }
}

/** Validates index.json; entries that do not fit are left out and reported. */
export function parseIndex(data: unknown): { index: ExtensionIndex; warnings: string[] } {
  const v = data as { schemaVersion?: unknown; extensions?: unknown }
  if (typeof v !== "object" || v === null || v.schemaVersion !== 1 || !Array.isArray(v.extensions)) {
    throw new PackageError('the extensions index must be {"schemaVersion": 1, "extensions": [...]}')
  }
  const warnings: string[] = []
  const extensions: IndexEntry[] = []
  const seen = new Set<string>()
  for (const [i, raw] of v.extensions.entries()) {
    const e = raw as Record<string, any>
    const problem =
      typeof e !== "object" || e === null
        ? "not an object"
        : typeof e.name !== "string" || !isValidPackageName(e.name)
          ? '"name" is not a valid name'
          : seen.has(e.name)
            ? "the name appears twice"
            : undefined
    const source = problem ? undefined : indexSource(e.source)
    if (problem || !source) {
      const why = problem ?? '"source" must be {"git": url, "path"?, "ref"?} or {"npm": spec}'
      warnings.push(`index entry ${i}${nameOf(raw)}: ${why}; skipped`)
      continue
    }
    const tags = Array.isArray(e.tags) ? e.tags.filter((t: unknown) => typeof t === "string") : []
    seen.add(e.name)
    extensions.push({
      name: e.name,
      description: typeof e.description === "string" ? e.description : "",
      version: typeof e.version === "string" ? e.version : "",
      source,
      ...(typeof e.engines?.amira === "string" ? { engine: e.engines.amira } : {}),
      tags,
      ...(typeof e.homepage === "string" ? { homepage: e.homepage } : {}),
    })
  }
  return { index: { schemaVersion: 1, extensions }, warnings }
}

/** Entries whose name, description or tags contain every word of the query. */
export function searchIndex(index: ExtensionIndex, query = ""): IndexEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return index.extensions.filter((e) => {
    const hay = [e.name, e.description, ...e.tags].join(" ").toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

function indexSource(s: any): PackageSource | undefined {
  if (typeof s !== "object" || s === null) return undefined
  if (typeof s.git === "string" && s.git) {
    if (s.path !== undefined && typeof s.path !== "string") return undefined
    if (s.ref !== undefined && typeof s.ref !== "string") return undefined
    if (typeof s.path === "string" && s.path.split(/[\\/]/).includes("..")) return undefined
    return { type: "git", url: s.git, ...(s.ref ? { ref: s.ref } : {}), ...(s.path ? { path: s.path } : {}) }
  }
  if (typeof s.npm === "string" && s.npm) return { type: "npm", spec: s.npm }
  return undefined
}

function nameOf(raw: unknown): string {
  const n = (raw as { name?: unknown } | null)?.name
  return typeof n === "string" ? ` (${n})` : ""
}

function parseJson(text: string, from: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new PackageError(`the extensions index ${from} is not valid JSON`)
  }
}

async function readCache(file: string, url: string): Promise<CacheFile | undefined> {
  try {
    const c = JSON.parse(await readFile(file, "utf8")) as CacheFile
    return typeof c?.fetchedAt === "number" && c.url === url ? c : undefined
  } catch {
    return undefined
  }
}

async function writeCache(file: string, body: CacheFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(body))
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
