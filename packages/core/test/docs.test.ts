import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CommandContext } from "@amira/api"
import { validateSettings } from "../src/config/schema.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

// The user docs (README*.md, docs/): their links resolve, their settings examples are valid,
// and the example extension in docs/extensions.md loads, runs and typechecks.

const root = path.resolve(import.meta.dir, "../../..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")

function pages(dir = "docs"): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const file = `${dir}/${e.name}`
    if (e.isDirectory()) return pages(file)
    return e.name.endsWith(".md") ? [file] : []
  })
}
const PAGES = ["README.md", "README.zh-CN.md", "README.ja.md", ...pages()]

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
function anchors(markdown: string): Set<string> {
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
  return new Set(
    [...prose.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
      m[1]!
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/ /g, "-"),
    ),
  )
}

test("every local link and anchor in the docs resolves", () => {
  const broken: string[] = []
  for (const page of PAGES) {
    const body = read(page)
    for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!
      if (/^[a-z]+:/i.test(target)) continue
      const [file, anchor] = target.split("#") as [string, string | undefined]
      const resolved = file ? path.posix.normalize(path.posix.join(path.posix.dirname(page), file)) : page
      if (!existsSync(path.join(root, resolved))) broken.push(`${page}: ${target}`)
      else if (anchor && resolved.endsWith(".md") && !anchors(read(resolved)).has(decodeURI(anchor)))
        broken.push(`${page}: ${target} (no such heading)`)
    }
  }
  expect(broken).toEqual([])
})

test.each(["zh", "ja"])("every English doc page has a %s one and the reverse", (language) => {
  const en = PAGES.filter((p) => /^docs\/[^/]+\.md$/.test(p)).map((p) => p.slice(5))
  const translated = PAGES.filter((p) => p.startsWith(`docs/${language}/`)).map((p) => p.slice(8))
  expect(translated.sort()).toEqual(en.sort())
})

test("every page links to its other two languages and documentation home", () => {
  const readmes = { en: "README.md", zh: "README.zh-CN.md", ja: "README.ja.md" }
  for (const page of PAGES) {
    const language =
      page.startsWith("docs/zh/") || page === readmes.zh
        ? "zh"
        : page.startsWith("docs/ja/") || page === readmes.ja
          ? "ja"
          : "en"
    const navigation = read(page).split(/\r?\n/)[2]!
    for (const other of ["en", "zh", "ja"] as const) {
      if (other === language) continue
      const target = page.startsWith("docs/")
        ? `docs/${other === "en" ? "" : `${other}/`}${path.posix.basename(page)}`
        : readmes[other]
      expect(navigation).toContain(`](${path.posix.relative(path.posix.dirname(page), target)})`)
    }
    if (page.startsWith("docs/")) {
      expect(navigation).toContain(`](${path.posix.relative(path.posix.dirname(page), readmes[language])})`)
    }
  }
})

test("Japanese code samples match the English sources", () => {
  const fences = (text: string) => [...text.matchAll(/```[^\n]*\n[\s\S]*?```/g)].map((m) => m[0])
  for (const page of PAGES.filter((p) => /^docs\/[^/]+\.md$/.test(p))) {
    expect(fences(read(`docs/ja/${path.posix.basename(page)}`)), page).toEqual(fences(read(page)))
  }
  expect(fences(read("README.ja.md"))).toEqual(fences(read("README.md")))
})

test("the JSON examples parse, and the settings ones are valid settings", () => {
  let settings = 0
  for (const page of PAGES) {
    for (const m of read(page).matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const value = JSON.parse(m[1]!)
      if (Object.hasOwn(value, "providers") || Object.hasOwn(value, "model") || isSettingsExtensions(value)) {
        expect(validateSettings(value, page).warnings).toEqual([])
        settings++
      }
    }
  }
  expect(settings).toBeGreaterThan(0)
})

/** `extensions` is an object in settings, an array of paths in a package manifest. */
const isSettingsExtensions = (v: Record<string, unknown>) =>
  Object.hasOwn(v, "extensions") && !Array.isArray(v.extensions)

test("the example extension in docs/extensions.md loads, runs and typechecks", async () => {
  const code = read("docs/extensions.md").match(/```ts\n([\s\S]*?)\n```/)![1]!
  for (const language of ["zh", "ja"]) {
    expect(read(`docs/${language}/extensions.md`).match(/```ts\n([\s\S]*?)\n```/)![1]).toBe(code)
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-doc-example-"))
  try {
    const entry = path.join(dir, "index.ts")
    writeFileSync(entry, code)
    const bus = new EventBus()
    const host = new ExtensionHost({
      bus,
      interceptors: new InterceptorRegistry(),
      tools: new ToolRegistry(),
      cwd: dir,
      settings: { extensions: { "hello-extension": { message: "Configured greeting." } } },
    })
    expect(await host.loadFile(entry, { name: "hello-extension" })).toBe(true)
    expect(host.status.snapshot()).toHaveLength(0)
    const printed: string[] = []
    const ctx = { print: (s: string) => void printed.push(s) } as CommandContext
    const hello = host.commands.get("hello")!.def
    await hello.run("", ctx)
    await hello.run("", ctx)
    expect(printed).toEqual(["Configured greeting.", "Configured greeting."])
    expect(host.status.snapshot()[0]!.text).toBe("Hello: 2")
    expect(host.unload(entry)).toBe(true)
    expect(host.commands.has("hello")).toBe(false)
    host.unloadAll()
    await bus.flush()

    const tsconfig = path.join(dir, "tsconfig.json")
    writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: path.join(root, "tsconfig.json"),
        compilerOptions: {
          paths: {
            "@amira/api": [path.join(root, "packages/api/src/index.ts")],
            "@amira/ai": [path.join(root, "packages/ai/src/index.ts")],
          },
          typeRoots: [path.join(root, "node_modules/@types")],
        },
        include: [entry],
      }),
    )
    const tsc = Bun.spawnSync(
      [process.execPath, path.join(root, "node_modules/typescript/bin/tsc"), "-p", tsconfig, "--noEmit"],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("")
    expect(tsc.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
