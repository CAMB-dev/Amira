import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { tryFileLock } from "@amira/core"
import { gitCacheKey, packageScope, writeLock } from "@amira/packages"
import { runExtCommand } from "../src/ext-command.ts"

let dir: string
let home: string
let cwd: string
let cacheDir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-cli-cache-regression-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "current")
  cacheDir = path.join(home, "cache", "git")
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

function cached(url: string) {
  const at = path.join(cacheDir, `${gitCacheKey(url)}.git`)
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, "amira-cache.json"), JSON.stringify({ url, lastUsed: new Date(0) }))
  return at
}

function pin(project: string, url: string) {
  writeLock(packageScope("project", { home, cwd: project }).lockFile, {
    lockfileVersion: 1,
    packages: {
      pinned: {
        version: "1.0.0",
        source: { type: "git", url },
        pinned: { commit: "a".repeat(40) },
        installedAt: new Date(0).toISOString(),
      },
    },
  })
}

async function ext(argv: string[]) {
  let out = ""
  let err = ""
  const code = await runExtCommand(
    argv,
    {
      stdout: (s) => {
        out += s
      },
      stderr: (s) => {
        err += s
      },
    },
    { home, cwd },
  )
  return { code, out, err }
}

test("cache regression: CLI prune keeps another known project's lock even without installed files", async () => {
  const url = "https://example.test/other"
  const other = path.join(dir, "other")
  pin(other, url)
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ packages: { untrustedProjects: [other] } }),
  )
  const kept = cached(url)
  const unused = cached("https://example.test/unused")
  expect((await ext(["cache", "prune"])).code).toBe(0)
  expect(existsSync(kept)).toBe(true)
  expect(existsSync(unused)).toBe(false)
})

test("cache regression: CLI dry-run names deletions and --all includes pinned repositories", async () => {
  const used = "https://example.test/used"
  const unused = "https://example.test/unused"
  pin(cwd, used)
  const kept = cached(used)
  const candidate = cached(unused)
  const preview = await ext(["cache", "prune", "--dry-run"])
  expect(preview.code).toBe(0)
  expect(preview.out).toContain(`Would remove ${unused}`)
  expect(preview.out).not.toContain(used)
  expect(existsSync(candidate)).toBe(true)
  const all = await ext(["cache", "prune", "--all", "--dry-run"])
  expect(all.out).toContain(`Would remove ${used}`)
  expect(all.out).toContain(`Would remove ${unused}`)
  expect(existsSync(kept)).toBe(true)
  expect((await ext(["cache", "prune", "--all"])).code).toBe(0)
  expect(existsSync(kept)).toBe(false)
  expect(existsSync(candidate)).toBe(false)
})

test("cache regression: interrupted clones do not produce a negative busy-cache count", async () => {
  cached("https://example.test/unused")
  mkdirSync(path.join(cacheDir, `${gitCacheKey("interrupted")}.git.tmp-999999999`))
  for (const argv of [
    ["cache", "prune", "--dry-run"],
    ["cache", "prune"],
  ]) {
    const result = await ext(argv)
    expect(result.code).toBe(0)
    expect(result.out).toContain("2 cached repositories")
    expect(result.err).toBe("")
  }
})

test("cache regression guard: clean keeps a repository locked by another operation", async () => {
  const url = "https://example.test/busy"
  const busy = cached(url)
  const lock = tryFileLock(path.join(cacheDir, `${gitCacheKey(url)}.lock`), 60_000)!
  try {
    const result = await ext(["cache", "clean"])
    expect(result.code).toBe(0)
    expect(existsSync(busy)).toBe(true)
    expect(result.err).toContain("in use by another amira process; kept")
  } finally {
    lock.release()
  }
})
