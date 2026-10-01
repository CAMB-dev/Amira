import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tryFileLock } from "@amira/core"
import {
  GitCache,
  gitCacheKey,
  type InstallProgress,
  installPackage,
  listGitCaches,
  normalizeGitUrl,
  packageScope,
  pruneGitCaches,
  readLock,
  readManifest,
  removeGitCache,
  restorePackages,
  updatePackages,
} from "../src/index.ts"

// git is slow to start on Windows, especially under load.
setDefaultTimeout(60_000)

let dir: string
let home: string
let cwd: string
let cacheDir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-git-cache-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  cacheDir = path.join(home, "cache", "git")
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

const user = () => packageScope("user", { home, cwd })

async function git(at: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd: at, stdout: "pipe", stderr: "pipe" },
  )
  const out = await new Response(p.stdout).text()
  const err = await new Response(p.stderr).text()
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`)
  return out.trim()
}

function makePackage(at: string, name: string, version: string) {
  mkdirSync(at, { recursive: true })
  writeFileSync(
    path.join(at, "package.json"),
    JSON.stringify({ name, version, type: "module", amira: { engines: { amira: "^0.1" } } }),
  )
  writeFileSync(path.join(at, "index.ts"), "export default () => {}\n")
}

/**
 * A monorepo like amira-extensions: packages under extensions/<name>. It serves partial clones
 * (as GitHub does), so the cache is blobless.
 */
async function monorepo(names: string[]): Promise<{ repo: string; url: string; head: string }> {
  const repo = path.join(dir, "exts")
  for (const n of names) makePackage(path.join(repo, "extensions", n), n, "1.0.0")
  writeFileSync(path.join(repo, "README.md"), "big file outside every package\n".repeat(1000))
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "config", "uploadpack.allowFilter", "true")
  await git(repo, "config", "uploadpack.allowAnySHA1InWant", "true")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "one")
  return { repo, url: pathToFileURL(repo).href, head: await git(repo, "rev-parse", "HEAD") }
}

function writeIndex(url: string, names: string[]): string {
  const file = path.join(dir, "index.json")
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      extensions: names.map((name) => ({
        name,
        description: "",
        version: "1.0.0",
        source: { git: url, path: `extensions/${name}` },
        tags: [],
      })),
    }),
  )
  return file
}

function opts(extra: object = {}) {
  return { scope: user(), cwd, cacheDir, ...extra }
}

function workDirs(): string[] {
  try {
    return readdirSync(user().dir).filter((n) => n.startsWith(".work-"))
  } catch {
    return []
  }
}

/** Every file under `root`, relative, with its bytes. */
function files(root: string, rel = ""): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) for (const [k, v] of files(root, r)) out.set(k, v)
    else out.set(r, readFileSync(path.join(root, r)))
  }
  return out
}

test("normalizeGitUrl gives the same key to the ways one repository is written", () => {
  expect(normalizeGitUrl("https://GitHub.com/CAMB-dev/amira-extensions.git/")).toBe(
    "https://github.com/CAMB-dev/amira-extensions",
  )
  expect(gitCacheKey("https://github.com/a/b")).toBe(gitCacheKey("HTTPS://github.com/a/b.git"))
  expect(gitCacheKey("git@GitHub.com:a/b.git")).toBe(gitCacheKey("git@github.com:a/b"))
  expect(gitCacheKey("https://github.com/a/b")).not.toBe(gitCacheKey("https://github.com/a/c"))
})

test("the first install makes a blobless cache of the repository; an update fetches into it", async () => {
  const { repo, url, head } = await monorepo(["alpha"])
  const index = { url: writeIndex(url, ["alpha"]) }
  const cache = new GitCache(cacheDir)
  const r = await installPackage("alpha", opts({ index, gitCache: cache }))
  expect(r.entry.pinned.commit).toBe(head)
  expect(cache.stats).toEqual({ lsRemote: 1, clone: 1, fetch: 0 })
  const bare = path.join(cacheDir, `${gitCacheKey(url)}.git`)
  expect(existsSync(path.join(bare, "HEAD"))).toBe(true)
  // Only the package's own files were downloaded: README.md's contents are not in the cache.
  const readme = await git(repo, "rev-parse", "HEAD:README.md")
  const missing = await git(bare, "rev-list", "--objects", "--missing=print", "--all")
  expect(missing.split("\n")).toContain(`?${readme}`)
  expect(listGitCaches(cacheDir)).toEqual([
    expect.objectContaining({ key: gitCacheKey(url), url, lastUsed: expect.any(Date) }),
  ])

  writeFileSync(path.join(repo, "extensions", "alpha", "index.ts"), "export default () => {} // two\n")
  await git(repo, "commit", "-qam", "two")
  const second = await git(repo, "rev-parse", "HEAD")
  const again = new GitCache(cacheDir)
  const [u] = await updatePackages(opts({ index, gitCache: again }))
  expect(u).toMatchObject({ changed: true, to: { pinned: { commit: second } } })
  expect(again.stats).toEqual({ lsRemote: 1, clone: 0, fetch: 1 })
  expect(readFileSync(path.join(user().dir, "alpha", "index.ts"), "utf8")).toContain("two")
  expect(workDirs()).toEqual([])
})

test("an update whose remote did not move asks ls-remote only, even without a cache", async () => {
  const { url } = await monorepo(["alpha"])
  const index = { url: writeIndex(url, ["alpha"]) }
  await installPackage("alpha", opts({ index }))
  const lock = readFileSync(user().lockFile, "utf8")
  rmSync(cacheDir, { recursive: true, force: true })
  const cache = new GitCache(cacheDir)
  const [u] = await updatePackages(opts({ index, gitCache: cache }))
  expect(u).toMatchObject({ name: "alpha", changed: false })
  expect(cache.stats).toEqual({ lsRemote: 1, clone: 0, fetch: 0 })
  expect(existsSync(cacheDir) && readdirSync(cacheDir).some((n) => n.endsWith(".git"))).toBe(false)
  expect(readFileSync(user().lockFile, "utf8")).toBe(lock)
})

test("a subdirectory is checked out byte for byte: CRLF, binary, nested; links become plain files", async () => {
  const { repo } = await monorepo(["alpha"])
  const pkg = path.join(repo, "extensions", "alpha")
  mkdirSync(path.join(pkg, "a", "b", "c"), { recursive: true })
  writeFileSync(path.join(pkg, "crlf.txt"), "one\r\ntwo\r\n")
  writeFileSync(path.join(pkg, "mixed.txt"), "lf\ncrlf\r\n")
  writeFileSync(path.join(pkg, "a", "b", "c", "deep.md"), "deep\n")
  const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256))
  writeFileSync(path.join(pkg, "a", "blob.bin"), binary)
  await git(repo, "add", "-A")
  // A symbolic link pointing out of the package, added without needing link support here.
  const linkBlob = await hashText(repo, "../../../outside")
  await git(repo, "update-index", "--add", "--cacheinfo", `120000,${linkBlob},extensions/alpha/link`)
  await git(repo, "commit", "-q", "-m", "files")
  const url = pathToFileURL(repo).href
  const index = { url: writeIndex(url, ["alpha"]) }
  // A user whose git converts line ends (the Git for Windows default) gets the same bytes.
  const saved = { ...process.env }
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_KEY_1: "core.eol",
    GIT_CONFIG_VALUE_1: "crlf",
  })
  try {
    await installPackage("alpha", opts({ index }))
  } finally {
    for (const k of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_KEY_1",
      "GIT_CONFIG_VALUE_1",
    ]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
  const installed = path.join(user().dir, "alpha")
  const got = files(installed)
  rmSync(path.join(pkg, "link"), { force: true })
  const want = files(pkg)
  want.set("link", Buffer.from("../../../outside"))
  expect([...got.keys()].sort()).toEqual([...want.keys()].sort())
  for (const [k, v] of want) expect(got.get(k)?.equals(v)).toBe(true)
  expect(lstatSync(path.join(installed, "link")).isSymbolicLink()).toBe(false)
  expect(existsSync(path.join(installed, "README.md"))).toBe(false)
})

async function hashText(repo: string, text: string): Promise<string> {
  const p = Bun.spawn(["git", "hash-object", "-w", "--stdin"], { cwd: repo, stdin: "pipe", stdout: "pipe" })
  p.stdin.write(text)
  await p.stdin.end()
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim()
}

test("many packages from one repository: one ls-remote and one download per command", async () => {
  const names = ["alpha", "beta", "gamma"]
  const { repo, url } = await monorepo(names)
  const index = { url: writeIndex(url, names) }
  const cache = new GitCache(cacheDir)
  for (const n of names) await installPackage(n, opts({ index, gitCache: cache }))
  expect(cache.stats).toEqual({ lsRemote: 1, clone: 1, fetch: 0 })

  for (const n of names) makePackage(path.join(repo, "extensions", n), n, "1.1.0")
  await git(repo, "commit", "-qam", "all move")
  const update = new GitCache(cacheDir)
  const progress: InstallProgress[] = []
  const results = await updatePackages(
    opts({ index, gitCache: update, onProgress: (p: InstallProgress) => progress.push(p) }),
  )
  expect(results.map((r) => ("changed" in r ? r.changed : r.error))).toEqual([true, true, true])
  expect(update.stats).toEqual({ lsRemote: 1, clone: 0, fetch: 1 })
  // Each package reports its own phases.
  expect(new Set(progress.map((p) => p.name))).toEqual(new Set(names))
  expect(progress.filter((p) => p.phase === "fetching").map((p) => p.name)[0]).toBe("alpha")
  expect(progress.some((p) => p.phase === "extracting" && p.name === "gamma")).toBe(true)
})

test("offline: pinned commits come from the cache; an update fails and keeps the old version", async () => {
  const { repo, url, head } = await monorepo(["alpha"])
  const index = { url: writeIndex(url, ["alpha"]) }
  await installPackage("alpha", opts({ index }))
  // The network goes away.
  renameSync(repo, `${repo}-away`)
  rmSync(path.join(user().dir, "alpha"), { recursive: true })
  const restored = await restorePackages(opts())
  expect(restored.map((r) => r.entry.pinned.commit)).toEqual([head])
  expect(readManifest(path.join(user().dir, "alpha")).version).toBe("1.0.0")

  const lock = readFileSync(user().lockFile, "utf8")
  const [u] = await updatePackages(opts({ index }))
  expect(u).toMatchObject({ name: "alpha", error: expect.stringMatching(/^cannot reach file:/) })
  expect(readFileSync(user().lockFile, "utf8")).toBe(lock)
  expect(existsSync(path.join(user().dir, "alpha", "index.ts"))).toBe(true)

  // A new install of the default branch uses the cached copy, with a warning.
  const logged: string[] = []
  rmSync(path.join(user().dir, "alpha"), { recursive: true })
  const again = await installPackage("alpha", opts({ index, log: (l: string) => logged.push(l) }))
  expect(again.entry.pinned.commit).toBe(head)
  expect(logged.some((l) => /^warning: cannot reach .*; using its cached copy/.test(l))).toBe(true)
  // Files the cache never downloaded cannot come from it.
  const whole = await installPackage(`${url}#main`, opts()).catch((e: Error) => e)
  expect(String(whole)).toMatch(/cannot download the files of file:.* at [0-9a-f]{12}/)
  expect(workDirs()).toEqual([])
})

test("offline without a cache: a clear error, nothing left behind", async () => {
  const { repo, url } = await monorepo(["alpha"])
  const index = { url: writeIndex(url, ["alpha"]) }
  await installPackage("alpha", opts({ index }))
  renameSync(repo, `${repo}-away`)
  rmSync(cacheDir, { recursive: true, force: true })
  rmSync(path.join(user().dir, "alpha"), { recursive: true })
  const err = await restorePackages(opts()).catch((e: Error) => e)
  expect(String(err)).toMatch(/cannot download file:.*: fatal: .*does not appear to be a git repository/)
  expect(existsSync(cacheDir) ? readdirSync(cacheDir).filter((n) => !n.endsWith(".lock")) : []).toEqual([])
  expect(workDirs()).toEqual([])
  expect(readLock(user().lockFile).packages.alpha).toBeDefined()
})

test("two amira processes share the cache: the second waits for the lock and downloads nothing", async () => {
  const { url } = await monorepo(["alpha", "beta"])
  const index = { url: writeIndex(url, ["alpha", "beta"]) }
  const lockFile = path.join(cacheDir, `${gitCacheKey(url)}.lock`)
  // Another live process holds the lock for a moment.
  const held = tryFileLock(lockFile, 60_000)!
  const phases: string[] = []
  const first = new GitCache(cacheDir)
  try {
    await installPackage(
      "alpha",
      opts({
        index,
        gitCache: first,
        onProgress: (p: InstallProgress) => {
          phases.push(p.phase)
          if (p.phase === "waiting") held.release()
        },
      }),
    )
  } finally {
    held.release()
  }
  expect(phases).toContain("waiting")
  // Concurrent installs from separate caches (separate processes): one clone between them.
  rmSync(cacheDir, { recursive: true, force: true })
  const a = new GitCache(cacheDir)
  const b = new GitCache(cacheDir)
  const project = packageScope("project", { home, cwd })
  await Promise.all([
    installPackage("alpha", opts({ index, gitCache: a })),
    installPackage("beta", { scope: project, cwd, cacheDir, index, gitCache: b }),
  ])
  expect(a.stats.clone + b.stats.clone).toBe(1)
  expect(a.stats.fetch + b.stats.fetch).toBe(0)
  expect(existsSync(lockFile)).toBe(false)
  // A lock left by a process that died is taken over.
  writeFileSync(lockFile, "999999999\n")
  const c = new GitCache(cacheDir)
  await installPackage("beta", opts({ index, gitCache: c }))
  expect(existsSync(lockFile)).toBe(false)
})

test("cache clean and prune: unused caches go, used and busy ones stay", async () => {
  const { url } = await monorepo(["alpha"])
  const index = { url: writeIndex(url, ["alpha"]) }
  await installPackage("alpha", opts({ index }))
  // A second repository no package uses any more, last used long ago.
  const other = path.join(dir, "other")
  makePackage(other, "other", "1.0.0")
  await git(other, "init", "-q", "-b", "main")
  await git(other, "add", "-A")
  await git(other, "commit", "-q", "-m", "one")
  const otherUrl = pathToFileURL(other).href
  await installPackage(otherUrl, opts())
  expect(listGitCaches(cacheDir).length).toBe(2)
  const now = Date.now()
  const metaFile = path.join(cacheDir, `${gitCacheKey(otherUrl)}.git`, "amira-cache.json")
  writeFileSync(
    metaFile,
    JSON.stringify({ url: otherUrl, lastUsed: new Date(now - 40 * 86_400_000).toISOString() }),
  )
  // A clone interrupted by a process that died.
  const leftover = path.join(cacheDir, `${gitCacheKey("x")}.git.tmp-999999999`)
  mkdirSync(leftover, { recursive: true })
  utimesSync(leftover, new Date(0), new Date(0))

  // Recently used: kept although nothing uses it.
  expect(pruneGitCaches(cacheDir, { keepUrls: [url, otherUrl], unusedForMs: 30 * 86_400_000 })).toEqual([])
  const pruned = pruneGitCaches(cacheDir, { keepUrls: [url], unusedForMs: 30 * 86_400_000 })
  expect(pruned.map((e) => e.url)).toEqual([otherUrl])
  expect(existsSync(leftover)).toBe(false)
  expect(listGitCaches(cacheDir).map((e) => e.url)).toEqual([url])

  // Busy: not removed.
  const held = tryFileLock(path.join(cacheDir, `${gitCacheKey(url)}.lock`), 60_000)!
  expect(removeGitCache(cacheDir, gitCacheKey(url))).toBe(false)
  held.release()
  expect(removeGitCache(cacheDir, gitCacheKey(url))).toBe(true)
  expect(listGitCaches(cacheDir)).toEqual([])
  // The package is still installed, and an update without a cache clones afresh.
  const [u] = await updatePackages(opts({ index }))
  expect(u).toMatchObject({ changed: false })
})

test("Ctrl+C during a download stops it and leaves no work directory, clone or lock", async () => {
  const { url } = await monorepo(["alpha"])
  const index = { url: writeIndex(url, ["alpha"]) }
  const ac = new AbortController()
  const err = await installPackage(
    "alpha",
    opts({
      index,
      signal: ac.signal,
      onProgress: (p: InstallProgress) => {
        if (p.phase === "fetching") ac.abort()
      },
    }),
  ).catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect(workDirs()).toEqual([])
  expect(existsSync(user().lockFile)).toBe(false)
  const left = existsSync(cacheDir) ? readdirSync(cacheDir) : []
  expect(left.filter((n) => n.endsWith(".lock") || n.includes(".tmp-"))).toEqual([])
  // The next run works.
  const r = await installPackage("alpha", opts({ index }))
  expect(r.name).toBe("alpha")
})

test("a tag that moved or went away upstream is followed without cloning again", async () => {
  const { repo, url, head } = await monorepo(["alpha"])
  await git(repo, "tag", "v1")
  const index = writeIndex(url, ["alpha"])
  const v = JSON.parse(readFileSync(index, "utf8"))
  v.extensions[0].source.ref = "v1"
  writeFileSync(index, JSON.stringify(v))
  expect((await installPackage("alpha", opts({ index: { url: index } }))).entry.pinned.commit).toBe(head)
  writeFileSync(path.join(repo, "extensions", "alpha", "index.ts"), "export default () => {} // v1 again\n")
  await git(repo, "commit", "-qam", "two")
  await git(repo, "tag", "-f", "v1")
  await git(repo, "tag", "gone")
  const second = await git(repo, "rev-parse", "HEAD")
  const logged: string[] = []
  const cache = new GitCache(cacheDir)
  const [u] = await updatePackages(
    opts({ index: { url: index }, gitCache: cache, log: (l: string) => logged.push(l) }),
  )
  expect(u).toMatchObject({ changed: true, to: { pinned: { commit: second } } })
  expect(cache.stats).toEqual({ lsRemote: 1, clone: 0, fetch: 1 })
  expect(logged).toEqual([])
  // A deleted tag is pruned from the cache.
  const bare = path.join(cacheDir, `${gitCacheKey(url)}.git`)
  expect(await git(bare, "tag", "--list")).toContain("gone")
  await git(repo, "tag", "-d", "gone")
  await git(repo, "commit", "-q", "--allow-empty", "-m", "three")
  await git(repo, "tag", "-f", "v1")
  await updatePackages(opts({ index: { url: index } }))
  expect(await git(bare, "tag", "--list")).not.toContain("gone")
})

test("a fetch that fails keeps the cache: a later offline restore still works", async () => {
  const { repo, url, head } = await monorepo(["alpha"])
  const index = { url: writeIndex(url, ["alpha"]) }
  await installPackage("alpha", opts({ index }))
  makePackage(path.join(repo, "extensions", "alpha"), "alpha", "2.0.0")
  await git(repo, "commit", "-qam", "two")
  // The remote answers ls-remote but cannot send objects (its object store is unreadable).
  const objects = path.join(repo, ".git", "objects")
  renameSync(objects, `${objects}-away`)
  mkdirSync(objects)
  const cache = new GitCache(cacheDir)
  const [u] = await updatePackages(opts({ index, gitCache: cache }))
  renameSync(objects, `${objects}-broken`)
  renameSync(`${objects}-away`, objects)
  expect(u).toMatchObject({ name: "alpha", error: expect.stringMatching(/^cannot (fetch|download)/) })
  expect(cache.stats.clone).toBe(0)
  expect(listGitCaches(cacheDir).length).toBe(1)
  renameSync(repo, `${repo}-away`)
  rmSync(path.join(user().dir, "alpha"), { recursive: true })
  const restored = await restorePackages(opts())
  expect(restored.map((r) => r.entry.pinned.commit)).toEqual([head])
})

test("an annotated tag, a branch and an abbreviated commit resolve like a clone would", async () => {
  const { repo, url, head } = await monorepo(["alpha"])
  await git(repo, "tag", "-a", "v1", "-m", "v1")
  await git(repo, "checkout", "-q", "-b", "side")
  writeFileSync(path.join(repo, "side.txt"), "side\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "side")
  const side = await git(repo, "rev-parse", "HEAD")
  await git(repo, "checkout", "-q", "main")
  const index = writeIndex(url, ["alpha"])
  const edit = (ref: string) => {
    const v = JSON.parse(readFileSync(index, "utf8"))
    v.extensions[0].source.ref = ref
    writeFileSync(index, JSON.stringify(v))
  }
  edit("v1")
  expect((await installPackage("alpha", opts({ index: { url: index } }))).entry.pinned.commit).toBe(head)
  edit("side")
  expect((await installPackage("alpha", opts({ index: { url: index } }))).entry.pinned.commit).toBe(side)
  edit(side.slice(0, 10))
  expect((await installPackage("alpha", opts({ index: { url: index } }))).entry.pinned.commit).toBe(side)
})
