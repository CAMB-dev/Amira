import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ExtensionStatus, ExtensionUpdate } from "@amira/api"
import { extensionStatusMetadata } from "@amira/api/internal/extension-status"
import {
  createExtensionAdmin,
  packageScope,
  parseIndex,
  readLock,
  readManifest,
  writeLock,
} from "../src/index.ts"
import { packageOperations, spawnTest } from "./spawn-operations.ts"

const { installPackage, updatePackages, start, stop } = packageOperations()
let dir: string
let home: string
let cwd: string
let savedHome: string | undefined

beforeEach(() => {
  start()
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-extension-status-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home)
  mkdirSync(cwd)
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
})

afterEach(async () => {
  try {
    await stop()
  } finally {
    if (savedHome === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = savedHome
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

function manifest(value: object = {}) {
  const source = path.join(dir, "source")
  mkdirSync(source, { recursive: true })
  writeFileSync(
    path.join(source, "amira-package.json"),
    JSON.stringify({ name: "status-pkg", version: "1.0.0", extensions: [], ...value }),
  )
  return source
}

function indexEntry(value: object = {}) {
  return { name: "status-pkg", source: { npm: "status-pkg" }, ...value }
}

function index(value: object = {}) {
  return { schemaVersion: 1, extensions: [indexEntry(value)] }
}

const installOptions = () => ({
  scope: packageScope("user", { home, cwd }),
  cwd,
  cacheDir: path.join(home, "cache", "git"),
})

test.each<ExtensionStatus>(["experimental", "wip", "deprecated"])(
  "manifest and index preserve %s metadata",
  (status) => {
    const metadata = { status, statusMessage: "Details" }
    const loaded = readManifest(manifest(metadata))
    expect(extensionStatusMetadata(loaded)).toEqual(metadata)
    expect(loaded).not.toHaveProperty("warnings")
    const parsed = parseIndex(index(metadata))
    expect(extensionStatusMetadata(parsed.index.extensions[0]!)).toEqual(metadata)
    expect(parsed.warnings).toEqual([])
  },
)

test("missing status has no metadata or warnings", () => {
  const loaded = readManifest(manifest({ statusMessage: "Ignored", replacedBy: "next-pkg" }))
  expect(extensionStatusMetadata(loaded)).toEqual({})
  expect(loaded).not.toHaveProperty("statusMessage")
  expect(loaded).not.toHaveProperty("replacedBy")
  expect(loaded).not.toHaveProperty("warnings")
  const parsed = parseIndex(index())
  expect(extensionStatusMetadata(parsed.index.extensions[0]!)).toEqual({})
  expect(parsed.warnings).toEqual([])
})

test("unknown status warns without rejecting the manifest or skipping the index entry", () => {
  const metadata = { status: "future", statusMessage: "Ignored", replacedBy: "next-pkg" }
  const loaded = readManifest(manifest(metadata))
  expect(extensionStatusMetadata(loaded)).toEqual({})
  expect(loaded.warnings).toEqual([expect.stringContaining("status-pkg")])
  const parsed = parseIndex(index(metadata))
  expect(parsed.index.extensions).toHaveLength(1)
  expect(extensionStatusMetadata(parsed.index.extensions[0]!)).toEqual({})
  expect(parsed.warnings).toEqual(loaded.warnings!)
})

test("replacement is retained only for deprecated packages", () => {
  for (const status of ["experimental", "wip", "deprecated"] as const) {
    const metadata = { status, replacedBy: "next-pkg" }
    const expected = status === "deprecated" ? metadata : { status }
    expect(extensionStatusMetadata(readManifest(manifest(metadata)))).toEqual(expected)
    expect(extensionStatusMetadata(parseIndex(index(metadata)).index.extensions[0]!)).toEqual(expected)
  }
})

test("status follows the manifest field precedence across supported formats", () => {
  const source = manifest({ status: "deprecated", replacedBy: "next-pkg" })
  writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "status-pkg", status: "wip", amira: { status: "experimental", extensions: [] } }),
  )
  expect(readManifest(source).status).toBe("deprecated")
  rmSync(path.join(source, "amira-package.json"))
  expect(readManifest(source).status).toBe("experimental")
  writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "status-pkg", status: "wip", amira: { extensions: [] } }),
  )
  expect(readManifest(source).status).toBe("wip")
})

spawnTest(
  "local install and update carry manifest metadata and parse warnings without logging notices",
  async () => {
    const logs: string[] = []
    const opts = { ...installOptions(), log: (line: string) => logs.push(line) }
    const installed = await installPackage(manifest({ status: "wip", statusMessage: "Details" }), opts)
    expect(extensionStatusMetadata(installed)).toEqual({ status: "wip", statusMessage: "Details" })
    expect(installed.warnings).toEqual([])
    manifest({ status: "deprecated", replacedBy: "next-pkg" })
    const [updated] = await updatePackages(opts)
    expect(updated).toMatchObject({ status: "deprecated", replacedBy: "next-pkg" })
    manifest({ status: "future" })
    const [invalid] = await updatePackages(opts)
    expect(invalid).toMatchObject({ warnings: [expect.stringContaining("status-pkg")] })
    if (!invalid || "error" in invalid) throw new Error("expected a successful update")
    expect(extensionStatusMetadata(invalid)).toEqual({})
    const invalidInstall = await installPackage(manifest({ status: "future" }), opts)
    expect(invalidInstall.warnings).toEqual(readManifest(path.join(dir, "source")).warnings!)
    expect(logs).toEqual([])
  },
)

spawnTest("direct status notification precedes copying and fires once per attempt", async () => {
  const notices: object[] = []
  const opts = {
    ...installOptions(),
    onStatus: (name: string, metadata: object) => notices.push({ name, ...metadata }),
    onProgress: (progress: { phase: string }) => {
      if (progress.phase === "copying") expect(notices).toHaveLength(1)
    },
  }
  await installPackage(manifest({ status: "wip" }), opts)
  expect(notices).toEqual([{ name: "status-pkg", status: "wip" }])
})

/** An in-memory npm registry; the only process invoked by installs is local tar extraction. */
function registry() {
  let metadata: object = {}
  const fakeFetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/package.tgz")) {
      const archive = new Bun.Archive(
        {
          "package/amira-package.json": JSON.stringify({
            name: "status-pkg",
            version: "1.0.0",
            extensions: [],
            ...metadata,
          }),
        },
        { compress: "gzip" },
      )
      return new Response(await archive.blob())
    }
    expect(String(url)).toMatch(/\/status-pkg$/)
    return Response.json({
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { dist: { tarball: "https://registry.invalid/package.tgz" } } },
    })
  }) as typeof fetch
  return { fetch: fakeFetch, metadata: (value: object) => (metadata = value) }
}

spawnTest("index notice fires once even when the fetched manifest disagrees", async () => {
  const registryStub = registry()
  registryStub.metadata({ status: "wip" })
  const file = path.join(dir, "index.json")
  writeFileSync(file, JSON.stringify(index({ status: "deprecated", replacedBy: "next-pkg" })))
  const notices: object[] = []
  const opts = {
    ...installOptions(),
    index: { url: file },
    fetch: Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        expect(notices).toHaveLength(1)
        return registryStub.fetch(...args)
      },
      { preconnect: fetch.preconnect },
    ),
    onStatus: (name: string, metadata: object) => notices.push({ name, ...metadata }),
  }
  const result = await installPackage("status-pkg", opts)
  expect(result.status).toBe("wip")
  expect(notices).toEqual([{ name: "status-pkg", status: "deprecated", replacedBy: "next-pkg" }])
})

spawnTest("index fallback and manifest precedence survive unchanged-pin updates", async () => {
  const registryStub = registry()
  const file = path.join(dir, "index.json")
  const catalog = (metadata: object) => writeFileSync(file, JSON.stringify(index(metadata)))
  catalog({ status: "deprecated", replacedBy: "next-pkg", statusMessage: "Catalog" })
  const logs: string[] = []
  const opts = {
    ...installOptions(),
    index: { url: file },
    fetch: registryStub.fetch,
    log: (line: string) => logs.push(line),
  }
  const installed = await installPackage("status-pkg", opts)
  expect(extensionStatusMetadata(installed)).toEqual({
    status: "deprecated",
    replacedBy: "next-pkg",
    statusMessage: "Catalog",
  })
  expect(installed.manifest).not.toHaveProperty("status")
  expect(createExtensionAdmin({ home, cwd }).list()[0]).toMatchObject({
    status: "deprecated",
    replacedBy: "next-pkg",
    statusMessage: "Catalog",
  })

  catalog({ status: "experimental", statusMessage: "New catalog" })
  const [same] = await updatePackages(opts)
  expect(same).toMatchObject({ changed: false, status: "experimental", statusMessage: "New catalog" })
  expect(same).not.toHaveProperty("replacedBy")
  expect(same).not.toHaveProperty("warnings")
  expect(createExtensionAdmin({ home, cwd }).list()[0]).toMatchObject({
    status: "experimental",
    statusMessage: "New catalog",
  })

  registryStub.metadata({ status: "wip", statusMessage: "Manifest" })
  const [manifestWins] = await updatePackages(opts)
  expect(manifestWins).toMatchObject({ changed: false, status: "wip", statusMessage: "Manifest" })
  const manifestInstall = await installPackage("status-pkg", opts)
  expect(extensionStatusMetadata(manifestInstall)).toEqual({ status: "wip", statusMessage: "Manifest" })

  registryStub.metadata({ status: "future" })
  const fallback = await installPackage("status-pkg", opts)
  expect(fallback).toMatchObject({
    status: "experimental",
    warnings: [expect.stringContaining("status-pkg")],
  })
  catalog({ status: "future" })
  const [invalid] = await updatePackages(opts)
  expect(invalid).toMatchObject({ changed: false, warnings: [expect.any(String)] })
  if (!invalid || "error" in invalid) throw new Error("expected a successful update")
  expect(extensionStatusMetadata(invalid)).toEqual({})
  expect(logs).toEqual([expect.stringContaining('unknown extension status "future"')])
})

spawnTest("a kept git pin still returns the latest index metadata without fetching", async () => {
  const opts = installOptions()
  await installPackage(manifest(), opts)
  const file = path.join(dir, "index.json")
  const commit = "a".repeat(40)
  const source = { git: "https://repository.invalid/never-fetch.git", ref: commit }
  const catalog = (metadata: object) => writeFileSync(file, JSON.stringify(index({ source, ...metadata })))
  const lock = readLock(opts.scope.lockFile)
  const entry = lock.packages["status-pkg"]!
  entry.source = { type: "git", url: source.git, ref: commit }
  entry.pinned = { commit }
  entry.index = { name: "status-pkg", url: file }
  writeLock(opts.scope.lockFile, lock)

  catalog({ status: "wip" })
  const [same] = await updatePackages(opts)
  expect(same).toMatchObject({ changed: false, status: "wip" })
  catalog({ status: "deprecated", replacedBy: "next-pkg" })
  const [latest] = await updatePackages(opts)
  expect(latest).toMatchObject({ changed: false, status: "deprecated", replacedBy: "next-pkg" })
})

spawnTest("index diagnostics survive failed updates and are reported once per index", async () => {
  const opts = installOptions()
  await installPackage(manifest(), opts)
  await installPackage(manifest({ name: "other-pkg" }), opts)
  const file = path.join(dir, "index.json")
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      extensions: [indexEntry({ status: "future" }), { name: "other-pkg", source: { npm: "other-pkg" } }],
    }),
  )
  const lock = readLock(opts.scope.lockFile)
  for (const [name, entry] of Object.entries(lock.packages)) entry.index = { name, url: file }
  writeLock(opts.scope.lockFile, lock)
  const results = await updatePackages({
    ...opts,
    fetch: Object.assign(
      async () => {
        throw new Error("fixture download failure")
      },
      { preconnect: fetch.preconnect },
    ),
  })
  expect(results.every((result) => "error" in result)).toBe(true)
  expect(results.flatMap((result) => result.warnings ?? [])).toEqual([
    expect.stringContaining('unknown extension status "future"'),
  ])
})

spawnTest("admin list, search, install and update preserve metadata and warnings", async () => {
  const file = path.join(dir, "index.json")
  writeFileSync(file, JSON.stringify(index({ status: "deprecated", replacedBy: "next-pkg" })))
  const admin = createExtensionAdmin({ home, cwd }, { index: { url: file } })
  const logs: string[] = []
  const opts = {
    signal: new AbortController().signal,
    log: (line: string) => logs.push(line),
    onProgress: () => {},
  }
  const searched = await admin.search("", opts.signal)
  expect(searched.extensions[0]).toMatchObject({ status: "deprecated", replacedBy: "next-pkg" })
  const installed = await admin.install(manifest({ status: "wip" }), "user", opts)
  expect(installed).toMatchObject({ status: "wip", warnings: [] })
  expect(admin.list()[0]).toMatchObject({ status: "wip" })
  manifest({ status: "deprecated", replacedBy: "next-pkg", statusMessage: "Details" })
  const updates: ExtensionUpdate[] = []
  await admin.update([], "user", opts, (result) => updates.push(result))
  expect(updates[0]).toMatchObject({ status: "deprecated", replacedBy: "next-pkg", statusMessage: "Details" })
  manifest({ status: "future" })
  const invalid = await admin.install(path.join(dir, "source"), "user", opts)
  expect(invalid.warnings).toEqual([expect.stringContaining("status-pkg")])
  expect(admin.list()[0]).toMatchObject({ warnings: invalid.warnings })
  await admin.update([], "user", opts, (result) => updates.push(result))
  expect(updates[1]).toMatchObject({ warnings: invalid.warnings })
  writeFileSync(file, JSON.stringify(index({ status: "future" })))
  expect((await admin.search("", opts.signal)).warnings).toHaveLength(1)
  expect(logs).toEqual([])
})
