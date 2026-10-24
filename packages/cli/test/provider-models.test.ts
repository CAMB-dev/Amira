import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadProviderModelCache } from "../src/provider-models.ts"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-provider-models-"))
  file = path.join(dir, "cache", "provider-models.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const provider = { id: "endpoint", baseUrl: "https://endpoint.example/v1" }

test("persists only model ids and limits, hashing URLs that may carry credentials", async () => {
  const endpoint = {
    ...provider,
    baseUrl: "https://user:embedded-password@endpoint.example/private-path?token=hidden-query",
    apiKey: "secret-api-key",
    headers: { authorization: "secret-header" },
  }
  const model = {
    id: "shared",
    contextWindow: 32000,
    maxOutput: 4000,
    apiKey: "secret-model-key",
    name: "untrusted-name",
    headers: { authorization: "secret-model-header" },
  }
  const cache = loadProviderModelCache(file)
  await cache.record(endpoint, [model])
  const text = readFileSync(file, "utf8")
  for (const secret of [
    endpoint.baseUrl,
    "embedded-password",
    "private-path",
    "hidden-query",
    endpoint.apiKey,
    "secret-header",
    model.apiKey,
    model.name,
    "secret-model-header",
    "apiKey",
    "headers",
  ])
    expect(text).not.toContain(secret)
  const raw = JSON.parse(text)
  expect(Object.keys(raw.providers)[0]).toMatch(/^endpoint:[a-f0-9]{64}$/)
  expect(Object.values(raw.providers)).toEqual([[{ id: "shared", contextWindow: 32000, maxOutput: 4000 }]])
  expect(loadProviderModelCache(file).lookup(endpoint, "shared")).toEqual({
    contextWindow: 32000,
    maxOutput: 4000,
  })
  expect(readdirSync(path.dirname(file))).toEqual(["provider-models.json"])
})

test("missing and malformed files or entries are harmless, including invalid numeric limits", async () => {
  expect(loadProviderModelCache(file).lookup(provider, "shared")).toBeUndefined()
  mkdirSync(path.dirname(file), { recursive: true })
  for (const text of ["{", "null", "[]", '{"version":1,"providers":null}', '{"version":99,"providers":{}}']) {
    writeFileSync(file, text)
    expect(loadProviderModelCache(file).lookup(provider, "shared")).toBeUndefined()
  }
  const cache = loadProviderModelCache(file)
  await cache.record(provider, [{ id: "shared", contextWindow: 32000 }])
  const raw = JSON.parse(readFileSync(file, "utf8"))
  raw.providers[Object.keys(raw.providers)[0]!] = [
    null,
    1,
    { id: 12, contextWindow: 1 },
    { id: "shared", contextWindow: -1, maxOutput: "4000", apiKey: "discard" },
    { id: "valid", contextWindow: 64000, maxOutput: null },
  ]
  raw.providers["unhashed-secret-url"] = [{ id: "shared", contextWindow: 12 }]
  writeFileSync(file, JSON.stringify(raw))
  const loaded = loadProviderModelCache(file)
  expect(loaded.lookup(provider, "shared")).toBeUndefined()
  expect(loaded.lookup(provider, "valid")).toEqual({ contextWindow: 64000 })
  await loaded.record({ ...provider, id: "second" }, [])
  expect(readFileSync(file, "utf8")).not.toContain("discard")
  expect(readFileSync(file, "utf8")).not.toContain("unhashed-secret-url")
})

test("replaces an endpoint snapshot and serializes overlapping writes without losing another provider", async () => {
  const cache = loadProviderModelCache(file)
  await Promise.all([
    cache.record(provider, [{ id: "old", contextWindow: 32000 }]),
    cache.record({ ...provider, id: "other" }, [{ id: "shared", maxOutput: 2000 }]),
    cache.record(provider, [{ id: "new", contextWindow: 64000, maxOutput: Number.NaN }]),
  ])
  const loaded = loadProviderModelCache(file)
  expect(loaded.lookup(provider, "old")).toBeUndefined()
  expect(loaded.lookup(provider, "new")).toEqual({ contextWindow: 64000 })
  expect(loaded.lookup({ ...provider, id: "other" }, "shared")).toEqual({ maxOutput: 2000 })
  expect(loaded.lookup({ ...provider, baseUrl: "https://changed.example" }, "new")).toBeUndefined()
})

test("failed disk writes do not discard in-memory limits or reject a successful model list", async () => {
  mkdirSync(file, { recursive: true })
  const cache = loadProviderModelCache(file)
  await cache.record(provider, [{ id: "shared", contextWindow: 16000 }])
  expect(cache.lookup(provider, "shared")).toEqual({ contextWindow: 16000 })
  expect(readdirSync(path.dirname(file))).toEqual(["provider-models.json"])
})

test("independent cache instances preserve each other's endpoint observations", async () => {
  const first = loadProviderModelCache(file)
  const second = loadProviderModelCache(file)
  const other = { ...provider, id: "other" }
  await first.record(provider, [{ id: "shared", contextWindow: 32000 }])
  await second.record(other, [{ id: "shared", contextWindow: 64000 }])
  const loaded = loadProviderModelCache(file)
  expect(loaded.lookup(provider, "shared")).toEqual({ contextWindow: 32000 })
  expect(loaded.lookup(other, "shared")).toEqual({ contextWindow: 64000 })
  await Promise.all([
    first.record(provider, [{ id: "shared", contextWindow: 48000 }]),
    second.record(other, [{ id: "shared", contextWindow: 96000 }]),
  ])
  const updated = loadProviderModelCache(file)
  expect(updated.lookup(provider, "shared")).toEqual({ contextWindow: 48000 })
  expect(updated.lookup(other, "shared")).toEqual({ contextWindow: 96000 })
})
