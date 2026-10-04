import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { GitCache, gitCacheKey, gitUrlsInUse, packageScope, pruneGitCaches, writeLock } from "../src/index.ts"
import * as tools from "../src/run.ts"

let dir: string
let home: string
let cwd: string
let cacheDir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-cache-regression-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "current")
  cacheDir = path.join(home, "cache", "git")
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

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

function cached(url: string) {
  const at = path.join(cacheDir, `${gitCacheKey(url)}.git`)
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, "amira-cache.json"), JSON.stringify({ url, lastUsed: new Date(0) }))
  return at
}

test("cache regression: prune protects locks beneath all session and trust paths", () => {
  const fromSession = path.join(dir, "session-project")
  const trusted = path.join(dir, "trusted")
  const untrusted = path.join(dir, "untrusted")
  const urls = [
    "https://example.test/session",
    "https://example.test/trusted",
    "https://example.test/untrusted",
  ]
  pin(path.join(fromSession, "nested"), urls[0]!)
  pin(trusted, urls[1]!)
  pin(path.join(untrusted, "nested"), urls[2]!)
  const sessions = path.join(home, "sessions", "project-key", "subagents")
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    path.join(sessions, "s_test.jsonl"),
    `${JSON.stringify({ type: "session", v: 1, cwd: fromSession })}\n`,
  )
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ packages: { trustedProjects: [trusted], untrustedProjects: [untrusted] } }),
  )
  const kept = urls.map(cached)
  const unused = cached("https://example.test/unused")
  expect(new Set(gitUrlsInUse({ home, cwd }))).toEqual(new Set(urls))
  expect(
    pruneGitCaches(cacheDir, { keepUrls: gitUrlsInUse({ home, cwd }), unusedForMs: 30 * 86_400_000 }).map(
      (e) => e.url,
    ),
  ).toEqual(["https://example.test/unused"])
  expect(kept.every(existsSync)).toBe(true)
  expect(existsSync(unused)).toBe(false)
})

test("cache regression: dry-run lists candidates without deleting caches or stale clones", () => {
  const used = "https://example.test/used"
  const unused = "https://example.test/unused"
  cached(used)
  const candidate = cached(unused)
  const leftover = path.join(cacheDir, `${gitCacheKey("leftover")}.git.tmp-999999999`)
  mkdirSync(leftover)
  expect(pruneGitCaches(cacheDir, { keepUrls: [used], dryRun: true }).map((e) => e.dir)).toEqual([
    candidate,
    leftover,
  ])
  expect(existsSync(candidate)).toBe(true)
  expect(existsSync(leftover)).toBe(true)
})

// This case starts real Git for setup, config and tree queries; parallel Windows
// process startup can exceed the default 5 s even without any network access.
test("cache regression: old git fallback blocks legacy promisors even when a transport is allowed", async () => {
  const url = "https://example.test/legacy"
  const commit = "a".repeat(40)
  const bare = cached(url)
  const remote = path.join(dir, "remote.git")
  await tools.runTool(["git", "init", "--bare", bare], dir, "git init")
  await tools.runTool(["git", "init", "--bare", remote], dir, "git init")
  for (const [key, value] of [
    ["extensions.partialClone", "origin"],
    ["remote.origin.promisor", "false"],
    ["remote.origin.url", remote],
    ["protocol.file.allow", "always"],
  ])
    await tools.runTool(["git", `--git-dir=${bare}`, "config", key!, value!], dir, "git config")
  const config = readFileSync(path.join(bare, "config"), "utf8")
  const trace = path.join(dir, "git-trace.log")
  const realRun = tools.runTool
  const run = spyOn(tools, "runTool").mockImplementation(async (argv, at, what, opts = {}) => {
    if (argv.includes("--version")) return "git version 2.44.0\n"
    if (argv.includes(`${commit}^{commit}`)) return commit
    // Emulate old git ignoring GIT_NO_LAZY_FETCH while using the real installed git.
    const env: Record<string, string> = { ...opts.env, GIT_TRACE: trace }
    delete env.GIT_NO_LAZY_FETCH
    return realRun(argv, at, what, { ...opts, env })
  })
  try {
    await new GitCache(cacheDir).withCommit({ url, commit }, {}, async (repo) => {
      expect(await repo.treesOf([`${"b".repeat(40)}^{tree}`])).toEqual([undefined])
    })
    expect(readFileSync(trace, "utf8")).not.toContain("upload-pack")
    expect(readFileSync(path.join(bare, "config"), "utf8")).toBe(config)
  } finally {
    run.mockRestore()
  }
}, 30_000)

for (const version of ["2.44.0", "2.45.0", "2.55.0.windows.5", "3.0.0"]) {
  test(`cache regression: git ${version} uses the supported no-lazy-fetch guard`, async () => {
    const url = "https://example.test/repo"
    const commit = "a".repeat(40)
    const bare = cached(url)
    mkdirSync(path.join(bare, "objects"))
    writeFileSync(path.join(bare, "HEAD"), `ref: refs/heads/main\n`)
    const config = '[remote "origin"]\n\tpromisor = true\n\turl = https://example.test/repo\n'
    writeFileSync(path.join(bare, "config"), config)
    const calls: { argv: string[]; env: tools.RunToolOptions["env"] }[] = []
    const run = spyOn(tools, "runTool").mockImplementation(async (argv, _cwd, _what, opts = {}) => {
      calls.push({ argv, env: opts.env })
      if (argv.includes("--version")) return `git version ${version}\n`
      if (argv.includes("rev-parse")) return argv.includes("--git-dir") ? bare : commit
      throw new Error(`unexpected git command: ${argv.join(" ")}`)
    })
    try {
      await new GitCache(cacheDir).withCommit({ url, commit }, {}, async (repo) => {
        expect(await repo.treesOf([`${commit}:extensions`])).toEqual([commit])
      })
      expect(calls.filter((c) => c.argv.includes("--version"))).toHaveLength(1)
      const queries = calls.filter((c) => c.argv.includes("rev-parse"))
      expect(queries.length).toBeGreaterThan(1)
      for (const query of queries) {
        if (version === "2.44.0") {
          expect(query.env?.GIT_NO_LAZY_FETCH).toBeUndefined()
          expect(query.argv).toContain("remote.origin.promisor=false")
          expect(query.argv).toContain("protocol.allow=never")
          expect(query.argv).toContain("remote.origin.partialclonefilter=blob:none")
          expect(query.env?.GIT_ALLOW_PROTOCOL).toBe("")
        } else expect(query.env?.GIT_NO_LAZY_FETCH).toBe("1")
      }
      expect(readFileSync(path.join(bare, "config"), "utf8")).toBe(config)
    } finally {
      run.mockRestore()
    }
  })
}
