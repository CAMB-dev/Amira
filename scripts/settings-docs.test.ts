import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as aiDefaults from "../packages/ai/src/settings-defaults.ts"
import * as defaults from "../packages/api/src/settings-defaults.ts"
import { loadSettings } from "../packages/core/src/config/load.ts"
import { validateSettings } from "../packages/core/src/config/schema.ts"
import { DEFAULT_MAX_LOG_BYTES } from "../packages/proc/src/job-inline.ts"
import { DEFAULT_BUFFER_CHARS, DEFAULT_MAX_RUNNING } from "../packages/proc/src/jobs.ts"
import {
  docFiles,
  endMarker,
  type Row,
  renderReference,
  root,
  sampleValue,
  settingsRows,
  startMarker,
  typeFiles,
} from "./gen-settings-docs.ts"
import { type Annotation, annotations, collapsed, extraRows, omitted } from "./settings-docs-data.ts"
import { type DefaultKey, documentedDefault, settingsDefaults } from "./settings-docs-defaults.ts"

function assertDocumentedDefaults(data: Record<string, Annotation>): void {
  for (const key of Object.keys(settingsDefaults) as DefaultKey[]) {
    expect(data[key]?.default, `documented default for ${key}`).toEqual(documentedDefault(key))
  }
}

const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n")
const generated = (doc: string) =>
  doc.slice(doc.indexOf(startMarker), doc.indexOf(endMarker) + endMarker.length)
const sources = () => typeFiles.map((file) => read(file))

/**
 * A settings object holding every key of the rows, each set to a value of its type. Rows for
 * records and lists of objects are filled by the rows under them; a list gets one item (in
 * `models[]`, with the `id` it requires). A number key gets its documented default when it has
 * one, as some have ranges no single sample fits (shares of a window, a minimum of 4000).
 */
function sample(rows: Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    if (row.type.fields || (row.type.args ?? []).some((t) => t.fields)) continue
    const parts = row.key.split(".")
    let at = out
    for (const part of parts.slice(0, -1)) {
      const name = part.replace(/^<\w+>$/, "a").replace(/\[\]$/, "")
      at[name] ??= part.endsWith("[]") ? [part === "models[]" ? { id: "a" } : {}] : {}
      const next = at[name]
      at = (Array.isArray(next) ? next[0] : next) as Record<string, unknown>
    }
    at[parts.at(-1)!.replace(/^<\w+>$/, "a")] = documentedNumber(row) ?? sampleValue(row.type)
  }
  return out
}

/** A number key's default, when its annotation documents one as a plain number. */
function documentedNumber(row: Row): number | undefined {
  const fallback = annotations[row.key]?.default
  const value = typeof fallback === "string" ? /^`(-?\d+(?:\.\d+)?)`/.exec(fallback)?.[1] : undefined
  return row.type.name === "number" && value !== undefined ? Number(value) : undefined
}

describe("settings reference", () => {
  const rows = settingsRows()

  test.each(Object.entries(docFiles))("%s is up to date with the types", (language, file) => {
    expect(generated(read(file))).toBe(renderReference(language as "en" | "zh", rows))
  })

  test("a changed or added settings key makes the documents stale", () => {
    const changed = sources().map((s) => s.replace("bell?: boolean", "bell?: number"))
    expect(renderReference("en", settingsRows(changed))).not.toBe(generated(read(docFiles.en)))
    const added = sources().map((s) => s.replace("bell?: boolean", "bell?: boolean\n  chime?: boolean"))
    expect(() => renderReference("en", settingsRows(added))).toThrow("tui.chime")
  })

  test("every fixed documented default equals the runtime constant", () => {
    assertDocumentedDefaults(annotations)
    for (const key of Object.keys(settingsDefaults)) {
      expect(
        [...rows, ...extraRows].some((row) => row.key === key),
        `default has no settings row: ${key}`,
      ).toBe(true)
    }
  })

  test("a changed documented default fails with the setting's key", () => {
    for (const key of Object.keys(settingsDefaults)) {
      const changed = { ...annotations, [key]: { ...annotations[key]!, default: "wrong" } }
      expect(() => assertDocumentedDefaults(changed)).toThrow(`documented default for ${key}`)
    }
  })

  test("new fixed defaults cannot bypass the constant checks", () => {
    const inherited = new Set([
      "providers.<id>.compat.webSearch",
      "providers.<id>.compat.thinkingDisplay",
      "providers.<id>.models[].compat.thinkingDisplay",
      "providers.<id>.catalogId",
      "providers.<id>.models[].dialect",
      "providers.<id>.models[].caps.webSearch",
      "providers.<id>.models[].thinking",
      "providers.<id>.models[].tools.edit",
      "compact.model",
      "agents.<role>.model",
      "mcpServers.<name>.type",
    ])
    for (const [key, annotation] of Object.entries(annotations)) {
      if (key in settingsDefaults || inherited.has(key)) continue
      const text = typeof annotation.default === "string" ? annotation.default : annotation.default.en
      expect(text, `missing runtime default assertion for ${key}`).toMatch(
        /^(none|unlimited|unknown|catalog|required(?: for (?:this backend|stdio|http))?)$/,
      )
    }
  })

  test("dependency-independent packages keep the same defaults", () => {
    const central = { ...defaults }
    for (const [name, value] of Object.entries(aiDefaults)) {
      expect(value, `ai default ${name}`).toEqual(central[name as keyof typeof aiDefaults])
    }
    expect(DEFAULT_MAX_RUNNING, "backgroundJobs.maxRunning").toBe(defaults.DEFAULT_BACKGROUND_MAX_RUNNING)
    expect(DEFAULT_BUFFER_CHARS, "backgroundJobs.bufferChars").toBe(defaults.DEFAULT_BACKGROUND_BUFFER_CHARS)
    expect(DEFAULT_MAX_LOG_BYTES, "backgroundJobs.maxLogBytes").toBe(
      defaults.DEFAULT_BACKGROUND_MAX_LOG_BYTES,
    )
  })

  test("the settings schema accepts every documented key", () => {
    expect(validateSettings(sample(rows), "settings.json").warnings).toEqual([])
  })

  test("the omitted keys are in the types, but settings files cannot set them", () => {
    const all = settingsRows(sources(), {})
    for (const [key] of Object.entries(omitted)) {
      const row = all.find((r) => r.key === key)
      expect(row?.key).toBe(key)
      const { warnings } = validateSettings(sample([{ key, type: row!.type }]), "s.json")
      expect(warnings.join("\n")).toContain(`"${key.replace(/<\w+>/g, "a").replace("[]", "[0]")}"`)
    }
    for (const key of collapsed) expect(rows.some((r) => r.key === key)).toBe(true)
  })

  test("the user-only marks match what project files may not set", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "amira-settings-docs-"))
    try {
      const home = path.join(dir, "home")
      const cwd = path.join(dir, "project")
      mkdirSync(home)
      mkdirSync(path.join(cwd, ".amira"), { recursive: true })
      writeFileSync(path.join(cwd, ".amira", "settings.json"), JSON.stringify(sample(rows)))
      const { warnings } = loadSettings({ cwd, home })
      const ignored = warnings
        .map((w) => /"([^"]+)" is ignored/.exec(w)?.[1])
        .filter((k) => k !== undefined)
        .map((k) => k.replace(/^providers\.a\./, "providers.<id>."))
      // The MCP extension reads mcpTrustedProjects from the user file itself.
      const marked = Object.entries(annotations)
        .filter(([key, a]) => a.userOnly && key !== "mcpTrustedProjects")
        .map(([key]) => key)
      expect(ignored.sort()).toEqual(marked.sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each(Object.entries(docFiles))("the JSON examples in %s are valid settings", (_, file) => {
    const blocks = [...read(file).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!)
    expect(blocks.length).toBeGreaterThan(3)
    for (const block of blocks) expect(validateSettings(JSON.parse(block), file).warnings).toEqual([])
  })
})
