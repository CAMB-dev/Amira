import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import fixture from "../../ai/test/fixtures/models-dev.json" with { type: "json" }
import pkg from "../package.json" with { type: "json" }
import { readCatalogCache, refreshCatalog } from "../src/catalog.ts"
import { createSession } from "../src/session.ts"

const here = import.meta.dir
const providers = [
  {
    id: "deepseek",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
]

async function tmpFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-catalog-"))
  return { dir, file: path.join(dir, "cache", "models.json") }
}

const serve = (body: unknown, calls = { n: 0 }, status = 200) =>
  (async () => {
    calls.n++
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch

const offline = (async () => {
  throw new Error("offline")
}) as unknown as typeof fetch

test("with no cache and no network there is simply no catalog", async () => {
  const { file } = await tmpFile()
  expect(await readCatalogCache({ file })).toEqual({ catalog: undefined, stale: true })
  expect(await refreshCatalog({ file, fetch: offline })).toBeUndefined()
  expect(await refreshCatalog({ file, fetch: serve({ error: "x" }, undefined, 500) })).toBeUndefined()
  expect(await refreshCatalog({ file, fetch: serve("junk") })).toBeUndefined()
  expect((await readCatalogCache({ file })).catalog).toBeUndefined()
})

test("a refresh caches a trimmed copy that is fresh for 24 hours, then stale but still used", async () => {
  const { dir, file } = await tmpFile()
  const t0 = Date.parse("2026-09-01T00:00:00Z")
  const fresh = await refreshCatalog({ file, fetch: serve(fixture), now: () => t0 })
  expect(fresh?.find("deepseek", "deepseek-flash")?.contextWindow).toBe(1_000_000)
  const saved = JSON.parse(await readFile(file, "utf8"))
  expect(saved.fetchedAt).toBe(t0)
  expect(saved.data.deepseek.models["deepseek-flash"].name).toBeUndefined()
  expect(await readdir(path.join(dir, "cache"))).toEqual(["models.json"])

  const soon = await readCatalogCache({ file, now: () => t0 + 60_000 })
  expect(soon.stale).toBe(false)
  expect(soon.catalog?.find("deepseek", "deepseek-flash")?.cost?.input).toBe(0.15)
  const later = await readCatalogCache({ file, now: () => t0 + 25 * 3600_000 })
  expect(later.stale).toBe(true)
  expect(later.catalog?.find("deepseek", "deepseek-flash")).toBeDefined()
})

test("catalog requests identify Amira with the CLI version", async () => {
  const { file } = await tmpFile()
  const headers: Headers[] = []
  const fetch = (async (_input, init) => {
    headers.push(new Headers(init?.headers))
    return Response.json(fixture)
  }) as typeof globalThis.fetch
  expect(await refreshCatalog({ file, fetch })).toBeDefined()
  expect(headers[0]?.get("user-agent")).toBe(`Amira/${pkg.version}`)
})

test("a corrupt cache counts as missing", async () => {
  const { file } = await tmpFile()
  await refreshCatalog({ file, fetch: serve(fixture) })
  await writeFile(file, "{not json")
  expect(await readCatalogCache({ file })).toEqual({ catalog: undefined, stale: true })
})

test("a session uses the cached catalog at once and refreshes a stale one in the background", async () => {
  const { file } = await tmpFile()
  const calls = { n: 0 }
  // No cache: the session starts with defaults, then picks up the catalog.
  const first = await createSession({
    model: "deepseek/deepseek-flash",
    cwd: here,
    extensions: [],
    noBuiltins: true,
    providers,
    catalog: { file, fetch: serve(fixture, calls) },
  })
  expect(first.agent.model.contextWindow).toBe(128_000)
  await first.catalogRefresh
  expect(calls.n).toBe(1)
  expect(first.agent.model.contextWindow).toBe(1_000_000)
  expect(first.agent.model.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 })

  // A fresh cache: used right away, and nothing is fetched.
  const second = await createSession({
    model: "deepseek/deepseek-flash",
    cwd: here,
    extensions: [],
    noBuiltins: true,
    providers,
    catalog: { file, fetch: serve(fixture, calls) },
  })
  expect(second.agent.model.contextWindow).toBe(1_000_000)
  await second.catalogRefresh
  expect(calls.n).toBe(1)
})

test("a model chosen during the refresh is not replaced", async () => {
  const { file } = await tmpFile()
  const s = await createSession({
    model: "deepseek/deepseek-flash",
    cwd: here,
    extensions: [],
    noBuiltins: true,
    providers,
    catalog: { file, fetch: serve(fixture) },
  })
  const chosen = { ...s.agent.model, id: "other" }
  s.agent.model = chosen
  await s.catalogRefresh
  expect(s.agent.model).toBe(chosen)
})
