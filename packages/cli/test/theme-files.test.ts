import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_THEME_GLYPHS, THEME_PALETTE_TOKENS, textCells } from "@amira/api"
import { ThemeRegistry, validateSettings } from "@amira/core"
import { readManifest } from "@amira/packages"
import { builtinThemes, loadThemeFiles } from "../src/theme-files.ts"

let dir: string
let home: string
let cwd: string
let notices: string[]
let registry: ThemeRegistry

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-theme-files-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  notices = []
  registry = new ThemeRegistry((text, origin) => notices.push(`${origin ?? "theme"}: ${text}`))
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

function put(file: string, value: unknown): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
  return file
}

const user = (name: string) => path.join(home, "themes", name)
const project = (name: string) => path.join(cwd, ".amira", "themes", name)

test("missing explicit home/project directories still load built-ins without notices", () => {
  const result = loadThemeFiles(registry, { home, cwd })
  expect(result.notices).toEqual([])
  expect(notices).toEqual([])
  expect(registry.list().map((theme) => theme.name)).toEqual(builtinThemes.map((theme) => theme.name).sort())
  expect(registry.get("amira")).toBeDefined()
  expect(registry.get("ascii")?.glyphs?.warning).toBe("!")
  expect(result.entries.every((entry) => entry.source === "built-in")).toBe(true)
})

test("built-in, user, project and package layers load in deterministic precedence order", () => {
  const a = put(user("a.json"), { name: "amira", dark: { accent: "#111111" } })
  const z = put(user("z.json"), { name: "amira", dark: { accent: "#222222" } })
  const p = put(project("theme.json"), { name: "amira", light: { accent: "#333333" } })
  const pa = put(path.join(dir, "package", "a.json"), {
    name: "amira",
    dark: { accent: "#444444" },
  })
  const pz = put(path.join(dir, "package", "z.json"), {
    name: "amira",
    light: { accent: "#555555" },
  })
  const result = loadThemeFiles(registry, { home, cwd, packageThemes: [pz, pa] })
  expect(result.entries.filter((entry) => entry.source !== "built-in").map((entry) => entry.origin)).toEqual([
    a,
    z,
    p,
    pz,
    pa,
  ])
  expect(registry.get("amira")).toEqual({ name: "amira", dark: { accent: "#444444" } })
  expect(notices.filter((text) => text.includes("replaces"))).toHaveLength(5)
  expect(result.notices).toEqual([])
})

test("a package manifest contributes JSON paths directly to the loader", () => {
  const packageDir = path.join(dir, "theme-pack")
  put(path.join(packageDir, "amira-package.json"), {
    name: "theme-pack",
    themes: ["themes/example.json"],
  })
  put(path.join(packageDir, "themes", "example.json"), {
    name: "package-theme",
    description: "Theme-only package",
    dark: { accent: "#abc" },
  })
  const manifest = readManifest(packageDir)
  expect(manifest.extensions).toEqual([])
  const result = loadThemeFiles(registry, { home, cwd, packageThemes: manifest.themes })
  expect(registry.get("package-theme")?.dark?.accent).toBe("#aabbcc")
  expect(result.notices).toEqual([])
  expect(notices).toEqual([])
})

test("bad JSON, unreadable package files and invalid definitions do not stop later themes", () => {
  const broken = put(user("a-broken.json"), "{")
  put(user("b-invalid.json"), { name: "bad-color", dark: { accent: "red" } })
  put(user("c-array.json"), [])
  put(user("d-valid.json"), { name: "valid", dark: { accent: "#123" } })
  const missing = path.join(dir, "package", "missing.json")
  const result = loadThemeFiles(registry, { home, cwd, packageThemes: [missing] })
  expect(result.notices).toHaveLength(2)
  expect(result.notices[0]).toContain(broken)
  expect(result.notices[1]).toContain(missing)
  expect(registry.get("bad-color")).toBeUndefined()
  expect(registry.get("valid")?.dark?.accent).toBe("#112233")
  expect(notices.some((text) => text.includes("hex color"))).toBe(true)
  expect(notices.some((text) => text.includes("definition must be an object"))).toBe(true)
})

test("unknown tokens and invalid glyphs are reported while valid overrides survive", () => {
  put(user("glyphs.json"), {
    name: "glyphs",
    dark: { accent: "#ABC", unsupported: "red" },
    glyphs: { image: "[]", user: "xx", rule: "\u001b[31m", bullets: ["*", "+"] },
  })
  loadThemeFiles(registry, { home, cwd })
  const theme = registry.get("glyphs")
  expect(theme?.dark).toEqual({ accent: "#aabbcc" })
  expect(theme?.glyphs).toEqual({ image: "[]", bullets: ["*", "+"] })
  expect(notices.some((text) => text.includes("unsupported"))).toBe(true)
  expect(notices.some((text) => text.includes("glyph user"))).toBe(true)
  expect(notices.some((text) => text.includes("glyph rule"))).toBe(true)
})

test("theme directories only scan immediate JSON files and report non-directory errors", () => {
  put(user("ignored.txt"), { name: "text-file" })
  put(user("nested/ignored.json"), { name: "nested-file" })
  put(project("valid.json"), { name: "project-theme" })
  let result = loadThemeFiles(registry, { home, cwd })
  expect(result.notices).toEqual([])
  expect(registry.get("text-file")).toBeUndefined()
  expect(registry.get("nested-file")).toBeUndefined()
  expect(registry.get("project-theme")).toBeDefined()
  rmSync(path.join(home, "themes"), { recursive: true })
  put(path.join(home, "themes"), "not a directory")
  result = loadThemeFiles(registry, { home, cwd })
  expect(result.notices).toHaveLength(1)
  expect(result.notices[0]).toContain("unable to read themes")
  expect(registry.get("project-theme")).toBeDefined()
})

test("reload replaces deleted file layers once and preserves extension registrations", () => {
  const file = put(user("temporary.json"), { name: "temporary", dark: { accent: "#123456" } })
  loadThemeFiles(registry, { home, cwd })
  const remove = registry.register({ name: "amira", dark: { accent: "#abcdef" } }, "extension", "test")
  rmSync(file)
  let updates = 0
  const unsubscribe = registry.subscribe(() => updates++)
  loadThemeFiles(registry, { home, cwd })
  expect(updates).toBe(1)
  expect(registry.get("temporary")).toBeUndefined()
  expect(registry.get("amira")?.dark?.accent).toBe("#abcdef")
  remove()
  expect(registry.get("amira")?.dark).toEqual({})
  unsubscribe()
})

test("every built-in JSON is statically imported and passes the shared registry validation", () => {
  const themesDir = path.resolve(import.meta.dir, "../themes")
  const jsons = readdirSync(themesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(themesDir, name), "utf8")))
  expect(builtinThemes.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual(
    jsons.toSorted((a, b) => a.name.localeCompare(b.name)),
  )
  loadThemeFiles(registry, { home, cwd })
  expect(notices).toEqual([])
  expect(registry.list()).toHaveLength(jsons.length)
})

test("the six built-ins keep the specified accent and heading colors without changing status or surfaces", () => {
  expect(builtinThemes.map((theme) => theme.name).sort()).toEqual([
    "amber",
    "amira",
    "ascii",
    "burnt",
    "lavender",
    "mono",
  ])
  const colors = {
    amber: [
      ["#e9a23b", "#f2b85c", "#dd8f63", "#e58a5a"],
      ["#b86e0a", "#a8610a", "#b3532a", "#b5532a"],
    ],
    burnt: [
      ["#e5792f", "#ef9148", "#d9a45c", "#e7a15e"],
      ["#b8510f", "#a8470c", "#94671f", "#94671f"],
    ],
    lavender: [
      ["#a99cf0", "#bdb3f5", "#8fb8ea", "#e2b07a"],
      ["#5848b8", "#4a3ca3", "#2f6aa6", "#94601f"],
    ],
    mono: [
      ["#e6e6e6", "#f2f2f2", "#cfcfcf", "#bdbdbd"],
      ["#111111", "#000000", "#333333", "#444444"],
    ],
  } as const
  for (const [name, variants] of Object.entries(colors)) {
    const theme = builtinThemes.find((theme) => theme.name === name)!
    for (const [index, variant] of (["dark", "light"] as const).entries()) {
      expect([
        theme[variant]?.accent,
        theme[variant]?.heading1,
        theme[variant]?.heading,
        theme[variant]?.path,
      ]).toEqual([...variants[index]!])
      for (const token of ["success", "error", "warning", "userBg", "codeBg", "diffAddedBg"] as const)
        expect(theme[variant]?.[token]).toBeUndefined()
    }
  }
})

test("ascii supplies every flat glyph key, only ASCII, and matching cell widths", () => {
  const theme = builtinThemes.find((theme) => theme.name === "ascii")!
  expect(Object.keys(theme.glyphs ?? {}).sort()).toEqual(Object.keys(DEFAULT_THEME_GLYPHS).sort())
  for (const [key, value] of Object.entries(theme.glyphs ?? {})) {
    const defaults = DEFAULT_THEME_GLYPHS[key as keyof typeof DEFAULT_THEME_GLYPHS]
    const values = Array.isArray(value) ? value : [value]
    const fallback = Array.isArray(defaults) ? defaults : [defaults]
    for (const [index, glyph] of values.entries()) {
      expect([...glyph].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126)).toBe(true)
      if (key !== "warning")
        expect(textCells(glyph)).toBe(textCells(fallback[Math.min(index, fallback.length - 1)]!))
    }
  }
  expect(theme.glyphs?.codeTop).toBe("+-")
  expect(theme.glyphs?.codeBottom).toBe("`-")
  expect(theme.glyphs?.image).toBe("[]")
})

test("published theme schema covers the canonical color and glyph keys", () => {
  const schema = JSON.parse(
    readFileSync(path.resolve(import.meta.dir, "../../../docs/themes.schema.json"), "utf8"),
  )
  expect(Object.keys(schema.$defs.palette.properties).sort()).toEqual([...THEME_PALETTE_TOKENS].sort())
  expect(Object.keys(schema.$defs.glyphs.properties).sort()).toEqual(Object.keys(DEFAULT_THEME_GLYPHS).sort())
  expect(schema.required).toEqual(["name"])
})

test("settings accepts theme names and checks auto/dark/light variants", () => {
  for (const theme of ["auto", "dark", "light", "terminal", "ascii", "custom-name"]) {
    for (const themeVariant of ["auto", "dark", "light"]) {
      expect(validateSettings({ tui: { theme, themeVariant } }, "settings.json").warnings).toEqual([])
    }
  }
  expect(() => validateSettings({ tui: { theme: 123 } }, "settings.json")).toThrow("tui.theme")
  expect(() => validateSettings({ tui: { themeVariant: "terminal" } }, "settings.json")).toThrow(
    "tui.themeVariant",
  )
})

test("theme files saved with a UTF-8 BOM still load", () => {
  put(user("bom.json"), `﻿${JSON.stringify({ name: "bom", dark: { accent: "#123456" } })}`)
  const result = loadThemeFiles(registry, { home, cwd })
  expect(result.notices).toEqual([])
  expect(registry.get("bom")?.dark?.accent).toBe("#123456")
})
