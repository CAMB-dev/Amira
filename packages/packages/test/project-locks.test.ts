import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { gitCachePins, gitUrlsInUse, packageScope, writeLock } from "../src/index.ts"

test("recorded project junctions or symlinks protect nested locks without following other links", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-project-links-"))
  const home = path.join(dir, "home")
  const target = path.join(dir, "target")
  const recorded = path.join(dir, "recorded-link")
  const outside = path.join(dir, "outside")
  const url = "https://example.test/pinned"
  const ignored = "https://example.test/outside"
  const pin = (cwd: string, source: string) =>
    writeLock(packageScope("project", { home, cwd }).lockFile, {
      lockfileVersion: 1,
      packages: {
        pinned: {
          version: "1.0.0",
          source: { type: "git", url: source },
          pinned: { commit: "a".repeat(40) },
          installedAt: new Date(0).toISOString(),
        },
      },
    })
  try {
    mkdirSync(home)
    pin(path.join(target, "child"), url)
    pin(outside, ignored)
    const type = process.platform === "win32" ? "junction" : "dir"
    symlinkSync(target, recorded, type)
    symlinkSync(outside, path.join(target, "unrecorded-link"), type)
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ packages: { trustedProjects: [recorded] } }),
    )
    expect(gitUrlsInUse({ home, cwd: path.join(dir, "current") })).toEqual([url])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test("an unreadable project lock is reported so prune keeps every cache", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-project-locks-bad-"))
  const home = path.join(dir, "home")
  const cwd = path.join(dir, "project")
  try {
    mkdirSync(home)
    const lock = packageScope("project", { home, cwd }).lockFile
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, "{ not json")
    const pins = gitCachePins({ home, cwd })
    expect(pins.urls).toEqual([])
    expect(pins.unreadable).toEqual([lock])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test("nested projects are looked for only a few levels below a recorded path", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-project-depth-"))
  const home = path.join(dir, "home")
  const near = path.join(dir, "root", "a", "b")
  const far = path.join(dir, "root", "a", "b", "c", "d", "e", "f")
  const pin = (cwd: string, url: string) =>
    writeLock(packageScope("project", { home, cwd }).lockFile, {
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
  try {
    mkdirSync(home)
    pin(near, "https://example.test/near")
    pin(far, "https://example.test/far")
    expect(gitUrlsInUse({ home, cwd: path.join(dir, "root") })).toEqual(["https://example.test/near"])
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
