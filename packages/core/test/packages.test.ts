import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  activePackages,
  DEFAULT_INDEX_MIRRORS,
  DEFAULT_INDEX_URL,
  installPackage,
  listInstalled,
  loadIndex,
  PackageError,
  packageScope,
  parseIndex,
  parseSpec,
  readLock,
  readManifest,
  removePackage,
  restorePackages,
  searchIndex,
  splitNpmSpec,
  updatePackages,
} from "../src/packages/index.ts"

// git is slow to start on Windows, especially under load.
setDefaultTimeout(60_000)

let dir: string
let home: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-packages-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

const user = () => packageScope("user", { home, cwd })
const project = () => packageScope("project", { home, cwd })

/** A package directory whose extension registers a tool named after `marker`. */
function makePackage(at: string, name: string, version: string, marker = name, extra: object = {}) {
  mkdirSync(at, { recursive: true })
  writeFileSync(
    path.join(at, "package.json"),
    JSON.stringify({ name, version, type: "module", amira: { engines: { amira: "^0.1" }, ...extra } }),
  )
  writeFileSync(
    path.join(at, "index.ts"),
    `export default (amira) => { amira.registerTool({ name: ${JSON.stringify(marker)}, description: "", parameters: {}, execute: async () => ({ content: [] }) }) }\n`,
  )
  return at
}

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
      ...args,
    ],
    {
      cwd: at,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const out = await new Response(p.stdout).text()
  expect(await p.exited).toBe(0)
  return out.trim()
}

async function gitRepo(at: string): Promise<string> {
  await git(at, "init", "-q", "-b", "main")
  await git(at, "add", "-A")
  await git(at, "commit", "-q", "-m", "one")
  return git(at, "rev-parse", "HEAD")
}

test("parseSpec tells paths, git URLs, npm specs and index names apart", () => {
  expect(parseSpec("./x", cwd)).toEqual({ type: "path", path: path.join(cwd, "x") })
  expect(parseSpec("https://github.com/a/b.git#v1", cwd)).toEqual({
    type: "git",
    url: "https://github.com/a/b.git",
    ref: "v1",
  })
  expect(parseSpec("git+ssh://git@host/a.git", cwd)).toEqual({ type: "git", url: "ssh://git@host/a.git" })
  expect(parseSpec("file:///tmp/r", cwd)).toMatchObject({ type: "git", url: "file:///tmp/r" })
  expect(parseSpec("npm:thing@^1", cwd)).toEqual({ type: "npm", spec: "thing@^1" })
  expect(parseSpec("@s/thing", cwd)).toEqual({ type: "npm", spec: "@s/thing" })
  expect(parseSpec("thing@2", cwd)).toEqual({ type: "npm", spec: "thing@2" })
  expect(parseSpec("mcp-server", cwd)).toEqual({ type: "name", name: "mcp-server" })
  expect(splitNpmSpec("@s/x@^2")).toEqual({ name: "@s/x", range: "^2" })
  expect(splitNpmSpec("x")).toEqual({ name: "x", range: "latest" })
})

test("readManifest takes amira-package.json, the amira field, or index.ts by default", () => {
  const a = makePackage(path.join(dir, "a"), "pkg-a", "1.2.3", "a", { skills: ["./skills"] })
  expect(readManifest(a)).toMatchObject({
    name: "pkg-a",
    version: "1.2.3",
    engine: "^0.1",
    extensions: [path.join(a, "index.ts")],
    skills: [path.join(a, "skills")],
  })
  const b = path.join(dir, "b")
  mkdirSync(b)
  writeFileSync(
    path.join(b, "amira-package.json"),
    JSON.stringify({ name: "b", commands: { serve: "./s.ts" } }),
  )
  expect(readManifest(b)).toMatchObject({
    name: "b",
    version: "0.0.0",
    extensions: [],
    commands: { serve: path.join(b, "s.ts") },
  })
  writeFileSync(
    path.join(b, "amira-package.json"),
    JSON.stringify({ name: "b", extensions: ["../escape.ts"] }),
  )
  expect(() => readManifest(b)).toThrow(/outside the package/)
  writeFileSync(path.join(b, "amira-package.json"), JSON.stringify({ name: "Bad Name" }))
  expect(() => readManifest(b)).toThrow(PackageError)
})

test("installs a local directory into the user scope and records it in the lock file", async () => {
  const src = makePackage(path.join(dir, "src"), "local-pkg", "1.0.0")
  mkdirSync(path.join(src, "node_modules", "junk"), { recursive: true })
  const r = await installPackage(path.relative(cwd, src), { scope: user(), cwd })
  expect(r.name).toBe("local-pkg")
  const installed = path.join(home, "packages", "local-pkg")
  expect(existsSync(path.join(installed, "index.ts"))).toBe(true)
  expect(existsSync(path.join(installed, "node_modules"))).toBe(false)
  const lock = readLock(path.join(home, "packages.lock"))
  expect(lock.packages["local-pkg"]).toMatchObject({ version: "1.0.0", source: { type: "path", path: src } })
  // Nothing is left behind from the work directory.
  expect(existsSync(path.join(home, "packages"))).toBe(true)
  expect(listInstalled({ home, cwd }).map((p) => p.name)).toEqual(["local-pkg"])

  expect(removePackage("local-pkg", user())).toBe(true)
  expect(existsSync(installed)).toBe(false)
  expect(readLock(path.join(home, "packages.lock")).packages).toEqual({})
  expect(removePackage("local-pkg", user())).toBe(false)
})

test("a package installs into its own repository's project scope without copying .amira", async () => {
  makePackage(cwd, "self-pkg", "1.0.0")
  mkdirSync(path.join(cwd, ".amira", "sessions"), { recursive: true })
  writeFileSync(path.join(cwd, ".amira", "sessions", "s.jsonl"), "{}\n")
  await installPackage(".", { scope: project(), cwd })
  const installed = path.join(cwd, ".amira", "packages", "self-pkg")
  expect(existsSync(path.join(installed, "index.ts"))).toBe(true)
  expect(existsSync(path.join(installed, ".amira"))).toBe(false)
  // Again, now that the scope holds a copy, and into the user scope from the same directory.
  await installPackage(".", { scope: project(), cwd })
  expect(existsSync(path.join(installed, ".amira"))).toBe(false)
  await installPackage(cwd, { scope: user(), cwd })
  expect(existsSync(path.join(home, "packages", "self-pkg", ".amira"))).toBe(false)
})

test("install clears work directories left by an interrupted install", async () => {
  const stale = path.join(home, "packages", ".work-999999999-abc")
  const live = path.join(home, "packages", `.work-${process.pid}-xyz`)
  mkdirSync(path.join(stale, "clone"), { recursive: true })
  mkdirSync(live, { recursive: true })
  await installPackage(makePackage(path.join(dir, "src"), "p", "1.0.0"), { scope: user(), cwd })
  expect(existsSync(stale)).toBe(false)
  expect(existsSync(live)).toBe(true)
})

test("remove refuses names that would reach outside the packages directory", async () => {
  const src = makePackage(path.join(dir, "src"), "keep-me", "1.0.0")
  await installPackage(src, { scope: user(), cwd })
  writeFileSync(path.join(home, "settings.json"), "{}")
  for (const bad of ["..", ".", "a/../b", "../home", "@x/..", "", "a\\..\\.."]) {
    expect(() => removePackage(bad, user())).toThrow(PackageError)
  }
  expect(existsSync(path.join(home, "settings.json"))).toBe(true)
  expect(existsSync(path.join(home, "packages", "keep-me", "index.ts"))).toBe(true)
  expect(() => removePackage("../..", project())).toThrow(PackageError)
  expect(existsSync(cwd)).toBe(true)
})

test("readLock rejects entries it cannot use, naming the file and key", () => {
  const file = path.join(home, "packages.lock")
  const write = (packages: object) => writeFileSync(file, JSON.stringify({ lockfileVersion: 1, packages }))
  const ok = { version: "1.0.0", source: { type: "path", path: "/x" }, pinned: {}, installedAt: "" }
  write({ a: ok })
  expect(Object.keys(readLock(file).packages)).toEqual(["a"])
  const { pinned: _, ...noPin } = ok
  write({ a: noPin })
  expect(() => readLock(file)).toThrow(/entry "a" has no "pinned"/)
  write({ a: { ...ok, source: { type: "svn" } } })
  expect(() => readLock(file)).toThrow(/entry "a" has no valid "source"/)
  write({ "..": ok })
  expect(() => readLock(file)).toThrow(/entry "\.\." is not a package name/)
  // Listing reports the broken lock file instead of crashing.
  write({ a: noPin })
  expect(listInstalled({ home, cwd })[0]?.error).toMatch(/has no "pinned"/)
})

test("refuses a package whose engine range this Amira does not satisfy", async () => {
  const src = makePackage(path.join(dir, "src"), "future", "1.0.0", "f", { engines: { amira: ">=9" } })
  await expect(installPackage(src, { scope: user(), cwd })).rejects.toThrow(/needs Amira extension API >=9/)
  expect(existsSync(path.join(home, "packages", "future"))).toBe(false)
})

test("installs from a git repository, pins the commit, restores the pin and updates past it", async () => {
  const repo = makePackage(path.join(dir, "repo"), "git-pkg", "1.0.0")
  const first = await gitRepo(repo)
  await git(repo, "tag", "v1")
  const url = pathToFileURL(repo).href
  const r = await installPackage(url, { scope: project(), cwd })
  expect(r.entry.pinned.commit).toBe(first)
  expect(r.entry.source).toEqual({ type: "git", url })
  const installed = path.join(cwd, ".amira", "packages", "git-pkg")
  expect(existsSync(path.join(installed, ".git"))).toBe(false)

  // A new commit upstream does not change what a restore installs.
  makePackage(repo, "git-pkg", "2.0.0")
  await git(repo, "commit", "-qam", "two")
  const second = await git(repo, "rev-parse", "HEAD")
  rmSync(installed, { recursive: true, force: true })
  expect(activePackages({ home, cwd }).problems[0]?.error).toMatch(/amira ext install --project/)
  const restored = await restorePackages({ scope: project(), cwd })
  expect(restored.map((x) => x.entry.pinned.commit)).toEqual([first])
  expect(readManifest(installed).version).toBe("1.0.0")

  // update moves the pin to the branch head.
  const [u] = await updatePackages({ scope: project(), cwd })
  expect(u).toMatchObject({ name: "git-pkg", changed: true, to: { pinned: { commit: second } } })
  expect(readManifest(installed).version).toBe("2.0.0")
  const [again] = await updatePackages({ scope: project(), cwd }, ["git-pkg"])
  expect(again).toMatchObject({ changed: false })

  // A #ref installs that tag's commit.
  const tagged = await installPackage(`${url}#v1`, { scope: user(), cwd })
  expect(tagged.entry.pinned.commit).toBe(first)
  expect(tagged.entry.source).toEqual({ type: "git", url, ref: "v1" })
  // Awaited before expect: .rejects on a promise waiting for the command worker never settles.
  const missing = await installPackage(`${url}#nope`, { scope: user(), cwd }).catch((e: Error) => e)
  expect(String(missing)).toMatch(/no branch, tag or commit/)
})

test("a project package replaces a user package of the same name; user ones load first", async () => {
  await installPackage(makePackage(path.join(dir, "u1"), "shared", "1.0.0", "from-user"), {
    scope: user(),
    cwd,
  })
  await installPackage(makePackage(path.join(dir, "u2"), "only-user", "1.0.0"), { scope: user(), cwd })
  await installPackage(makePackage(path.join(dir, "p1"), "shared", "2.0.0", "from-project"), {
    scope: project(),
    cwd,
  })
  const all = listInstalled({ home, cwd })
  expect(all.map((p) => [p.scope, p.name, !!p.shadowed])).toEqual([
    ["user", "only-user", false],
    ["user", "shared", true],
    ["project", "shared", false],
  ])
  const active = activePackages({ home, cwd })
  expect(active.packages.map((p) => `${p.scope}:${p.name}@${p.manifest.version}`)).toEqual([
    "user:only-user@1.0.0",
    "project:shared@2.0.0",
  ])
  expect(active.problems).toEqual([])
})

function fixtureIndex(repoUrl: string) {
  return {
    schemaVersion: 1,
    extensions: [
      {
        name: "sub-pkg",
        description: "An extension in a subdirectory",
        version: "0.3.0",
        source: { git: repoUrl, path: "packages/sub-pkg" },
        engines: { amira: "^0.1" },
        tags: ["demo", "mcp"],
      },
      {
        name: "npm-thing",
        description: "From npm",
        version: "1.0.0",
        source: { npm: "npm-thing@^1" },
        tags: [],
      },
      { name: "broken", source: { svn: "x" } },
    ],
  }
}

test("names resolve through the extensions index, including a subdirectory of a git repository", async () => {
  const repo = path.join(dir, "exts")
  makePackage(path.join(repo, "packages", "sub-pkg"), "sub-pkg", "0.3.0")
  const commit = await gitRepo(repo)
  const indexFile = path.join(dir, "index.json")
  writeFileSync(indexFile, JSON.stringify(fixtureIndex(pathToFileURL(repo).href)))

  const loaded = await loadIndex({ url: indexFile })
  expect(loaded.index.extensions.map((e) => e.name)).toEqual(["sub-pkg", "npm-thing"])
  expect(loaded.warnings).toEqual([expect.stringContaining("(broken)")])
  expect(searchIndex(loaded.index, "MCP").map((e) => e.name)).toEqual(["sub-pkg"])
  expect(searchIndex(loaded.index).length).toBe(2)

  const r = await installPackage("sub-pkg", { scope: user(), cwd, index: { url: indexFile } })
  expect(r.entry).toMatchObject({
    version: "0.3.0",
    source: { type: "git", path: "packages/sub-pkg" },
    index: { name: "sub-pkg", url: indexFile },
    pinned: { commit },
  })
  expect(existsSync(path.join(home, "packages", "sub-pkg", "index.ts"))).toBe(true)
  await expect(installPackage("absent", { scope: user(), cwd, index: { url: indexFile } })).rejects.toThrow(
    /not in the extensions index/,
  )
})

test("the index is cached with a TTL and the cache is used offline", async () => {
  const cacheFile = path.join(home, "cache", "extensions-index.json")
  const body = JSON.stringify(fixtureIndex("https://example.invalid/x.git"))
  let calls = 0
  let online = true
  const fakeFetch = (async () => {
    calls++
    if (!online) throw new Error("offline")
    return new Response(body)
  }) as unknown as typeof fetch
  let now = 1_000_000
  const opts = { url: "https://example.invalid/index.json", cacheFile, fetch: fakeFetch, now: () => now }
  await loadIndex(opts)
  await loadIndex(opts)
  expect(calls).toBe(1)
  now += 2 * 60 * 60 * 1000
  online = false
  const stale = await loadIndex(opts)
  expect(calls).toBe(2)
  expect(stale.index.extensions.length).toBe(2)
  expect(stale.warnings[0]).toMatch(/using the copy from/)
  rmSync(cacheFile)
  await expect(loadIndex(opts)).rejects.toThrow(/cannot download the extensions index/)
})

test("the default index falls back to its mirror when raw.githubusercontent.com is unreachable", async () => {
  const cacheFile = path.join(home, "cache", "extensions-index.json")
  const body = JSON.stringify(fixtureIndex("https://example.invalid/x.git"))
  const asked: string[] = []
  const fakeFetch = (async (url: string) => {
    asked.push(url)
    if (url === DEFAULT_INDEX_URL) throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com")
    return new Response(body)
  }) as unknown as typeof fetch
  const loaded = await loadIndex({ url: DEFAULT_INDEX_URL, cacheFile, fetch: fakeFetch })
  expect(loaded.index.extensions.length).toBe(2)
  expect(asked).toEqual(DEFAULT_INDEX_MIRRORS)
  // Every source failing names each one.
  rmSync(cacheFile)
  const down = (async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch
  await expect(loadIndex({ url: DEFAULT_INDEX_URL, cacheFile, fetch: down })).rejects.toThrow(
    /jsdelivr.*offline/,
  )
  // A URL the user chose has no mirrors.
  asked.length = 0
  await expect(
    loadIndex({ url: "https://example.invalid/index.json", cacheFile, fetch: fakeFetch, refresh: true }),
  ).resolves.toBeDefined()
  expect(asked).toEqual(["https://example.invalid/index.json"])
})

test("parseIndex rejects a file that is not an index", () => {
  expect(() => parseIndex({ extensions: [] })).toThrow(/schemaVersion/)
  expect(parseIndex({ schemaVersion: 1, extensions: [], future: true }).index.extensions).toEqual([])
})

test("npm packages are resolved on the registry, checked and pinned to version and integrity", async () => {
  // Build a tarball the way npm lays it out: everything under package/.
  const staging = path.join(dir, "tgz")
  makePackage(path.join(staging, "package"), "npm-thing", "1.4.0")
  const tgz = path.join(dir, "npm-thing-1.4.0.tgz")
  const tar = Bun.spawn(["tar", "-czf", path.basename(tgz), "-C", "tgz", "package"], {
    cwd: dir,
    stderr: "pipe",
  })
  expect(await tar.exited).toBe(0)
  const bytes = readFileSync(tgz)
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`
  const meta = {
    "dist-tags": { latest: "2.0.0" },
    versions: {
      "1.4.0": { dist: { tarball: "https://registry.test/npm-thing/-/1.4.0.tgz", integrity } },
      "1.2.0": { dist: { tarball: "https://registry.test/other.tgz" } },
      "2.0.0": { dist: { tarball: "https://registry.test/other.tgz" } },
    },
  }
  const fakeFetch = (async (url: string) =>
    url.endsWith(".tgz") ? new Response(bytes) : Response.json(meta)) as unknown as typeof fetch
  const r = await installPackage("npm:npm-thing@^1", {
    scope: user(),
    cwd,
    fetch: fakeFetch,
    npmRegistry: "https://registry.test",
  })
  expect(r.entry.pinned).toEqual({ version: "1.4.0", integrity })
  expect(readManifest(path.join(home, "packages", "npm-thing")).version).toBe("1.4.0")
})

test("update keeps going past a package that fails, which keeps its files and pin; unchanged ones stay as they are", async () => {
  const repo = makePackage(path.join(dir, "repo"), "git-pkg", "1.0.0")
  const first = await gitRepo(repo)
  const url = pathToFileURL(repo).href
  await installPackage(url, { scope: user(), cwd })
  const other = makePackage(path.join(dir, "other"), "other-pkg", "1.0.0")
  await gitRepo(other)
  await installPackage(pathToFileURL(other).href, { scope: user(), cwd })
  // Point other-pkg at a ref that does not exist, as a hand-edited lock might.
  const lockFile = path.join(home, "packages.lock")
  const edited = JSON.parse(readFileSync(lockFile, "utf8"))
  edited.packages["other-pkg"].source.ref = "no-such-ref"
  writeFileSync(lockFile, JSON.stringify(edited, null, 2))
  const before = readFileSync(lockFile, "utf8")
  const logged: string[] = []

  // Nothing new upstream: git-pkg is left alone (lock untouched); other-pkg fails and is kept.
  const quiet = await updatePackages({ scope: user(), cwd, log: (l) => logged.push(l) })
  expect(quiet.map((r) => ("error" in r ? `${r.name}: error` : `${r.name}: ${r.changed}`))).toEqual([
    "git-pkg: false",
    "other-pkg: error",
  ])
  expect(quiet[1]).toMatchObject({ error: expect.stringMatching(/no branch, tag or commit "no-such-ref"/) })
  expect(readFileSync(lockFile, "utf8")).toBe(before)
  expect(readManifest(path.join(home, "packages", "other-pkg")).version).toBe("1.0.0")
  expect(readdirSync(path.join(home, "packages")).sort()).toEqual(["git-pkg", "other-pkg"])

  // A new commit: git-pkg moves on although other-pkg, listed after it, still fails.
  makePackage(repo, "git-pkg", "2.0.0")
  await git(repo, "commit", "-qam", "two")
  const second = await git(repo, "rev-parse", "HEAD")
  const [moved, failed] = await updatePackages({ scope: user(), cwd })
  expect(moved).toMatchObject({ name: "git-pkg", changed: true, to: { pinned: { commit: second } } })
  expect(moved).toMatchObject({ from: { pinned: { commit: first } } })
  expect(failed).toMatchObject({ name: "other-pkg", error: expect.any(String) })
  const lock = readLock(lockFile)
  expect(lock.packages["git-pkg"]!.pinned.commit).toBe(second)
  expect(lock.packages["other-pkg"]!.source).toMatchObject({ ref: "no-such-ref" })
  expect(readManifest(path.join(home, "packages", "git-pkg")).version).toBe("2.0.0")
})

test("update reads the index afresh, and updates from the recorded source when the index is out of reach", async () => {
  const repo = path.join(dir, "exts")
  makePackage(path.join(repo, "packages", "sub-pkg"), "sub-pkg", "0.3.0")
  const first = await gitRepo(repo)
  await git(repo, "tag", "v1")
  makePackage(path.join(repo, "packages", "sub-pkg"), "sub-pkg", "0.4.0")
  await git(repo, "commit", "-qam", "two")
  const second = await git(repo, "rev-parse", "HEAD")
  const repoUrl = pathToFileURL(repo).href
  let body = JSON.stringify(fixtureIndex(repoUrl))
  let online = true
  const fakeFetch = (async () => {
    if (!online) throw new Error("offline")
    return new Response(body)
  }) as unknown as typeof fetch
  const index = {
    url: "https://example.invalid/index.json",
    cacheFile: path.join(home, "cache", "extensions-index.json"),
    fetch: fakeFetch,
  }
  const r = await installPackage("sub-pkg", { scope: user(), cwd, index })
  expect(r.entry.pinned.commit).toBe(second)

  // The index now pins the tag; its cached copy is still fresh, but update asks again.
  const pinned = fixtureIndex(repoUrl)
  pinned.extensions[0]!.source = { git: repoUrl, path: "packages/sub-pkg", ref: "v1" } as never
  body = JSON.stringify(pinned)
  const [u] = await updatePackages({ scope: user(), cwd, index })
  expect(u).toMatchObject({ changed: true, to: { version: "0.3.0", pinned: { commit: first } } })

  // Offline with no cached index: the recorded source (the tag) is used, and it says so.
  online = false
  rmSync(index.cacheFile)
  const logged: string[] = []
  const [offline] = await updatePackages({ scope: user(), cwd, index, log: (l) => logged.push(l) }, [
    "sub-pkg",
  ])
  expect(offline).toMatchObject({ name: "sub-pkg", changed: false })
  expect(logged).toContain("sub-pkg: updating from its recorded source")
  expect(logged.some((l) => /cannot read the extensions index .*offline/.test(l))).toBe(true)
  // The lock keeps the index it came from.
  expect(readLock(path.join(home, "packages.lock")).packages["sub-pkg"]!.index).toEqual({
    name: "sub-pkg",
    url: index.url,
  })
})
