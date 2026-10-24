import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Ai, ModelLimits } from "@amira/ai"
import { amiraPath, waitFileLock } from "@amira/core"

type Endpoint = { id: string; baseUrl: string }
type ListedModel = ModelLimits & { id: string }

export interface ProviderModelCache {
  lookup(provider: Endpoint, modelId: string): ModelLimits | undefined
  /** Replaces this endpoint's list. Persistence is best effort; live limits update immediately. */
  record(provider: Endpoint, models: readonly ListedModel[]): Promise<void>
}

// URLs can contain credentials, query tokens and private paths: persist only their digest.
const endpointKey = (provider: Endpoint) =>
  `${provider.id}:${createHash("sha256").update(provider.baseUrl).digest("hex")}`

function modelsFrom(value: unknown): ListedModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((model: unknown) => {
    if (!model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string") return []
    const limits: ListedModel = { id: model.id }
    for (const field of ["contextWindow", "maxOutput"] as const) {
      const n = (model as Record<string, unknown>)[field]
      if (typeof n === "number" && Number.isFinite(n) && n > 0) limits[field] = n
    }
    return [limits]
  })
}

function readEntries(file: string): Map<string, ListedModel[]> {
  const entries = new Map<string, ListedModel[]>()
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
): ProviderModelCache {
  const entries = readEntries(file)
  let writing = Promise.resolve()
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
      const listed = modelsFrom(models)
      entries.set(key, listed)
      writing = writing.then(async () => {
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
        try {
          await mkdir(path.dirname(file), { recursive: true })
          const lock = await waitFileLock(`${file}.lock`, { staleMs: 30_000, waitMs: 2000 })
          try {
            // Merge under the lock: another session/process may have refreshed a different endpoint.
            const latest = readEntries(file)
            latest.set(key, listed)
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
  ai.setModelLimits?.(cache.lookup)
  installed.set(ai, { file, cache })
  return cache
}
