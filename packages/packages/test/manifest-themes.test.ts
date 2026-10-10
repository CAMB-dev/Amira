import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PackageError, readManifest } from "../src/index.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-manifest-themes-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

function manifest(value: object) {
  writeFileSync(path.join(dir, "amira-package.json"), JSON.stringify({ name: "theme-pack", ...value }))
}

test("a theme-only manifest needs no implicit extension and resolves theme paths", () => {
  manifest({ themes: ["themes/a.json", "./themes/b.json"] })
  expect(readManifest(dir)).toMatchObject({
    extensions: [],
    skills: [],
    themes: [path.join(dir, "themes", "a.json"), path.join(dir, "themes", "b.json")],
  })
})

test("the package.json amira field can contribute themes without an extension", () => {
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "theme-pack", version: "1.2.3", amira: { themes: ["theme.json"] } }),
  )
  expect(readManifest(dir)).toMatchObject({
    name: "theme-pack",
    version: "1.2.3",
    extensions: [],
    themes: [path.join(dir, "theme.json")],
  })
})

test("themes default to an empty list and coexist with extensions and commands", () => {
  manifest({ extensions: [] })
  expect(readManifest(dir).themes).toEqual([])
  manifest({ themes: ["theme.json"], extensions: ["extension.ts"], commands: { demo: "demo.ts" } })
  expect(readManifest(dir)).toMatchObject({
    themes: [path.join(dir, "theme.json")],
    extensions: [path.join(dir, "extension.ts")],
    commands: { demo: path.join(dir, "demo.ts") },
  })
})

test("an empty theme list is still a valid data-only package", () => {
  manifest({ themes: [] })
  expect(readManifest(dir).extensions).toEqual([])
})

test("theme paths use the same type and containment validation as other contributions", () => {
  for (const themes of ["theme.json", [42], [null], ["../escape.json"]]) {
    manifest({ themes })
    expect(() => readManifest(dir)).toThrow(PackageError)
  }
  manifest({ themes: [path.resolve(dir, "..", "escape.json")] })
  expect(() => readManifest(dir)).toThrow(/outside the package/)
  mkdirSync(path.join(dir, "themes"))
  manifest({ themes: ["themes/../theme.json"] })
  expect(readManifest(dir).themes).toEqual([path.join(dir, "theme.json")])
})
