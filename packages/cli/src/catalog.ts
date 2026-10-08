import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createCatalog, type ModelCatalog, trimModelsDev } from "@amira/ai"
import { amiraPath } from "@amira/core"
import { USER_AGENT } from "./user-agent.ts"

export const MODELS_URL = "https://models.dev/api.json"
const DAY_MS = 24 * 60 * 60 * 1000

export interface CatalogCacheOptions {
  /** Defaults to ~/.amira/cache/models.json. */
  file?: string
  url?: string
  fetch?: typeof fetch
  now?: () => number
  /** How long a cached copy counts as fresh. Default 24 h. */
  ttlMs?: number
  /** Gives up on a download after this long. Default 15 s. */
  timeoutMs?: number
}

export interface CachedCatalog {
  /** The cached catalog, stale or not; undefined when there is no usable cache. */
  catalog: ModelCatalog | undefined
  /** Whether the cache is missing or older than the TTL, so a refresh is due. */
  stale: boolean
}

interface CacheFile {
  fetchedAt: number
  source: string
  data: unknown
}

/** Reads the cached catalog without touching the network (D51). */
export async function readCatalogCache(opts: CatalogCacheOptions = {}): Promise<CachedCatalog> {
  const file = opts.file ?? amiraPath("cache", "models.json")
  const now = (opts.now ?? Date.now)()
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as CacheFile
    if (typeof cached?.fetchedAt !== "number" || !cached.data) return { catalog: undefined, stale: true }
    const age = now - cached.fetchedAt
    return { catalog: createCatalog(cached.data), stale: age < 0 || age > (opts.ttlMs ?? DAY_MS) }
  } catch {
    return { catalog: undefined, stale: true }
  }
}

/**
 * Downloads the catalog and caches a trimmed copy. Resolves to the new catalog, or to
 * undefined when offline or the download is unusable; never rejects.
 */
export async function refreshCatalog(opts: CatalogCacheOptions = {}): Promise<ModelCatalog | undefined> {
  const file = opts.file ?? amiraPath("cache", "models.json")
  const url = opts.url ?? MODELS_URL
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    if (!res.ok) return undefined
    const data = trimModelsDev(await res.json())
    if (!data) return undefined
    const body: CacheFile = { fetchedAt: (opts.now ?? Date.now)(), source: url, data }
    await writeCache(file, JSON.stringify(body)).catch(() => {})
    return createCatalog(data)
  } catch {
    return undefined
  }
}

/** Writes through a temporary file so a reader never sees half a cache. */
async function writeCache(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, text)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}
