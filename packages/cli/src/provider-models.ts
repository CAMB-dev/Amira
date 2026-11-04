import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Ai, ModelLimits } from "@amira/ai"
import { amiraPath, waitFileLock } from "@amira/core"

type Endpoint = { id: string; baseUrl: string }
type ListedModel = ModelLimits & { id: string }
/** `learnedAt`: when the window was learned (learn()) rather than listed, in ms since the epoch. */
type StoredModel = ListedModel & { learnedAt?: number }

/** How long a learned window outlives refreshes whose listing states none. */
export const LEARNED_WINDOW_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface ProviderModelCache {
  lookup(provider: Endpoint, modelId: string): ModelLimits | undefined
  /** Replaces this endpoint's list. Persistence is best effort; live limits update immediately. */
  record(provider: Endpoint, models: readonly ListedModel[]): Promise<void>
  /**
   * Lowers one model's limits to what the endpoint revealed (e.g. in an overflow error); never
   * raises them. A later record() replaces a learned window with a listed one, and keeps it
   * for LEARNED_WINDOW_TTL_MS when the listing states none.
   */
  learn(provider: Endpoint, modelId: string, limits: ModelLimits): Promise<void>
}

// URLs can contain credentials, query tokens and private paths: persist only their digest.
const endpointKey = (provider: Endpoint) =>
  `${provider.id}:${createHash("sha256").update(provider.baseUrl).digest("hex")}`

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0

function modelsFrom(value: unknown): StoredModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((model: unknown) => {
    if (!model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string") return []
    const limits: StoredModel = { id: model.id }
    for (const field of ["contextWindow", "maxOutput"] as const) {
      const n = (model as Record<string, unknown>)[field]
      if (positive(n)) limits[field] = n
    }
    const learnedAt = (model as Record<string, unknown>).learnedAt
    if (positive(learnedAt) && limits.contextWindow !== undefined) limits.learnedAt = learnedAt
    return [limits]
  })
}

function readEntries(file: string): Map<string, StoredModel[]> {
  const entries = new Map<string, StoredModel[]>()
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (raw && typeof raw === "object" && "version" in raw && raw.version === 1 && "providers" in raw) {
      const providers = raw.providers
      if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        for (const [key, value] of Object.entries(providers)) {
          if (/^[a-z0-9][a-z0-9._-]*:[a-f0-9]{64}$/.test(key)) entries.set(key, modelsFrom(value))
        }
      }
    }
  } catch {
    // A missing or malformed cache never prevents startup or a successful provider probe.
  }
  return entries
}

/** Local endpoint observations only: no settings, credentials, headers or network access. */
export function loadProviderModelCache(
  file = amiraPath("cache", "provider-models.json"),
  { now = Date.now }: { now?: () => number } = {},
): ProviderModelCache {
  const entries = readEntries(file)
  let writing = Promise.resolve()
  /** Applies a change now, then again under the lock to the file's latest content. */
  const persist = (change: (entries: Map<string, StoredModel[]>) => void) => {
    change(entries)
    writing = writing.then(async () => {
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await mkdir(path.dirname(file), { recursive: true })
        const lock = await waitFileLock(`${file}.lock`, { staleMs: 30_000, waitMs: 2000 })
        try {
          // Merge under the lock: another session/process may have refreshed a different endpoint.
          const latest = readEntries(file)
          change(latest)
          await writeFile(tmp, JSON.stringify({ version: 1, providers: Object.fromEntries(latest) }))
          await rename(tmp, file)
        } finally {
          lock.release()
        }
      } catch {
        // Read-only/offline environments still retain the observations for this process.
      } finally {
        await rm(tmp, { force: true }).catch(() => {})
      }
    })
    return writing
  }
  return {
    lookup(provider, modelId) {
      const model = entries.get(endpointKey(provider))?.find((m) => m.id === modelId)
      if (!model || (model.contextWindow === undefined && model.maxOutput === undefined)) return undefined
      return {
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
      }
    },
    record(provider, models) {
      const key = endpointKey(provider)
      const listed = modelsFrom(models).map(({ learnedAt: _, ...model }) => model)
      return persist((all) => {
        const before = all.get(key)
        const fresh = now() - LEARNED_WINDOW_TTL_MS
        all.set(
          key,
          listed.map((model) => {
            // Only a recently learned window survives a listing that states none.
            const old = before?.find((m) => m.id === model.id)
            return model.contextWindow === undefined &&
              old?.contextWindow !== undefined &&
              old.learnedAt !== undefined &&
              old.learnedAt > fresh
              ? { ...model, contextWindow: old.contextWindow, learnedAt: old.learnedAt }
              : model
          }),
        )
      })
    },
    learn(provider, modelId, limits) {
      const key = endpointKey(provider)
      return persist((all) => {
        const models = all.get(key) ?? []
        const current = models.find((m) => m.id === modelId)
        const next: StoredModel = { ...current, id: modelId }
        for (const field of ["contextWindow", "maxOutput"] as const) {
          const n = limits[field]
          if (positive(n) && n < (next[field] ?? Number.POSITIVE_INFINITY)) next[field] = n
        }
        if (next.contextWindow !== current?.contextWindow) next.learnedAt = now()
        all.set(key, [...models.filter((m) => m !== current), next])
      })
    },
  }
}

const installed = new WeakMap<Ai, { file: string; cache: ProviderModelCache }>()

/** Share one mutable lookup between startup and provider administration on a live Ai. */
export function installProviderModelCache(
  ai: Ai,
  file = amiraPath("cache", "provider-models.json"),
): ProviderModelCache {
  const current = installed.get(ai)
  if (current?.file === file) return current.cache
  const cache = loadProviderModelCache(file)
  ai.setModelLimits?.(
    cache.lookup,
    (provider, modelId, limits) => void cache.learn(provider, modelId, limits),
  )
  installed.set(ai, { file, cache })
  return cache
}
