// Generates the key tables of docs/settings.md and docs/zh/settings.md from the settings types
// (packages/api/src/settings.ts and the types it uses) and the reviewed defaults, descriptions
// and translations in settings-docs-data.ts. `bun scripts/gen-settings-docs.ts` rewrites the
// generated blocks; `--check` only reports whether they are stale. settings-docs.test.ts fails
// when they are.
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  type Annotation,
  annotations,
  collapsed,
  extraRows,
  omitted,
  sections,
} from "./settings-docs-data.ts"

export const root = fileURLToPath(new URL("../", import.meta.url))
export const typeFiles = [
  "packages/api/src/settings.ts",
  "packages/api/src/subagents.ts",
  "packages/ai/src/providers.ts",
  "packages/ai/src/dialect.ts",
  "packages/ai/src/types.ts",
]
export const docFiles = { en: "docs/settings.md", zh: "docs/zh/settings.md" } as const
export type Language = keyof typeof docFiles

export interface Type {
  name: string
  args?: Type[]
  fields?: Field[]
}
interface Field {
  name: string
  optional: boolean
  type: Type
}
export interface Row {
  /** Dotted path; `<id>`-style segments stand for a record's keys and `[]` for list items. */
  key: string
  type: Type
}

// A type-only grammar: interfaces with `extends`, type aliases, string literals, unions and
// intersections, arrays, generics (Record, Partial, Omit) and inline object types. Anything
// else fails loudly instead of silently losing fields.
class Parser {
  readonly tokens: string[]
  pos = 0

  constructor(source: string) {
    this.tokens = (source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|\w+|\S/g) ?? []).filter(
      (t) => !t.startsWith("//") && !t.startsWith("/*"),
    )
  }

  peek() {
    return this.tokens[this.pos]
  }

  take(want?: string): string {
    const token = this.tokens[this.pos++]
    if (token === undefined || (want !== undefined && want !== token)) {
      throw new Error(`Expected ${want ?? "a token"}, got ${token}`)
    }
    return token
  }

  type(): Type {
    if (this.peek() === "|") this.take()
    const union = [this.intersection()]
    while (this.peek() === "|") {
      this.take()
      union.push(this.intersection())
    }
    return union.length === 1 ? union[0]! : { name: "|", args: union }
  }

  intersection(): Type {
    const parts = [this.primary()]
    while (this.peek() === "&") {
      this.take()
      parts.push(this.primary())
    }
    return parts.length === 1 ? parts[0]! : { name: "&", args: parts }
  }

  primary(): Type {
    let type: Type
    if (this.peek() === "{") type = { name: "object", fields: this.fields() }
    else if (this.peek() === "(") {
      this.take()
      type = this.type()
      this.take(")")
    } else {
      const name = this.take()
      if (!/^(\w+|"(?:\\.|[^"\\])*")$/.test(name)) throw new Error(`Unsupported type token ${name}`)
      type = { name }
      if (this.peek() === "<") {
        this.take()
        const args = [this.type()]
        while (this.peek() === ",") {
          this.take()
          args.push(this.type())
        }
        this.take(">")
        type.args = args
      }
    }
    while (this.peek() === "[") {
      this.take()
      this.take("]")
      type = { name: "array", args: [type] }
    }
    return type
  }

  fields(): Field[] {
    this.take("{")
    const fields: Field[] = []
    while (this.peek() !== "}") {
      const name = this.take()
      if (!/^\w+$/.test(name)) throw new Error(`Unsupported property ${name}`)
      const optional = this.peek() === "?"
      if (optional) this.take()
      this.take(":")
      fields.push({ name, optional, type: this.type() })
      if (this.peek() === ";" || this.peek() === ",") this.take()
    }
    this.take("}")
    return fields
  }
}

const readSources = () => typeFiles.map((file) => readFileSync(path.join(root, file), "utf8"))

/** Names a record's keys in a row key, e.g. `providers.<id>`. */
const recordKeyName: Record<string, string> = {
  providers: "id",
  agents: "role",
  commandAliases: "alias",
  mcpServers: "name",
  extensions: "name",
}

/**
 * Every settings key the types define, outermost first, except objects that are only walked
 * into (their fields get rows). Keys in `omitted` are left out, and those in `collapsed` get
 * one row, with what is under them.
 */
export function settingsRows(sources = readSources(), omit: Record<string, string> = omitted): Row[] {
  const cache = new Map<string, Type>()
  const resolving = new Set<string>()
  const resolve = (name: string): Type => {
    const cached = cache.get(name)
    if (cached) return cached
    if (resolving.has(name)) throw new Error(`Recursive settings type ${name}`)
    resolving.add(name)
    const pattern = new RegExp(`export (interface|type) ${name}\\b`)
    const source = sources.find((s) => pattern.test(s))
    if (!source) throw new Error(`Cannot find settings type ${name}`)
    const parser = new Parser(source.slice(source.search(pattern)))
    parser.take("export")
    const kind = parser.take()
    parser.take(name)
    let type: Type
    if (kind === "type") {
      parser.take("=")
      type = parser.type()
    } else {
      const parents: Type[] = []
      if (parser.peek() === "extends") {
        do {
          parser.take()
          parents.push(parser.type())
        } while (parser.peek() === ",")
      }
      type = { name: "object", fields: [...parents.flatMap(fieldsOf), ...parser.fields()] }
    }
    cache.set(name, type)
    resolving.delete(name)
    return type
  }
  const fieldsOf = (type: Type): Field[] => {
    if (type.fields) return type.fields
    if (type.name === "&") return type.args!.flatMap(fieldsOf)
    if (type.name === "Partial") return fieldsOf(type.args![0]!).map((f) => ({ ...f, optional: true }))
    if (type.name === "Omit") {
      const excluded = type.args![1]!
      const names = (excluded.name === "|" ? excluded.args! : [excluded]).map((t) => t.name.slice(1, -1))
      return fieldsOf(type.args![0]!).filter((f) => !names.includes(f.name))
    }
    return fieldsOf(resolve(type.name))
  }
  /** The type with named types, Partial, Omit and intersections written out. */
  const expand = (type: Type): Type => {
    if (type.fields || type.name === "&" || type.name === "Partial" || type.name === "Omit") {
      return { name: "object", fields: fieldsOf(type).map((f) => ({ ...f, type: expand(f.type) })) }
    }
    if (type.args) return { ...type, args: type.args.map(expand) }
    if (/^[A-Z]/.test(type.name)) return expand(resolve(type.name))
    return type
  }
  /** A list's item or a record's value, which the keys under it hang off, and its key. */
  const inner = (type: Type, key: string): [Type, string] => {
    if (type.name === "array") return inner(type.args![0]!, `${key}[]`)
    if (type.name === "Record") {
      const value = type.args![1]!
      if (!value.fields && value.name !== "array" && value.name !== "Record") return [value, key]
      const name = recordKeyName[key]
      if (!name) throw new Error(`Name the keys of ${key} in recordKeyName`)
      return inner(value, `${key}.<${name}>`)
    }
    return [type, key]
  }
  const rows: Row[] = []
  const walk = (type: Type, key: string) => {
    for (const field of type.fields ?? []) {
      const at = key ? `${key}.${field.name}` : field.name
      if (Object.hasOwn(omit, at)) continue
      if (collapsed.includes(at)) {
        rows.push({ key: at, type: field.type })
        continue
      }
      if (!field.type.fields) rows.push({ key: at, type: field.type })
      walk(...inner(field.type, at))
    }
  }
  walk(expand(resolve("Settings")), "")
  return rows
}

/** How a type reads in the tables. */
export function showType(type: Type): string {
  if (type.fields) return "object"
  if (type.name === "array") {
    const item = showType(type.args![0]!)
    return item.includes(" ") ? `(${item})[]` : `${item}[]`
  }
  if (type.name === "|" || type.name === "&") return type.args!.map(showType).join(` ${type.name} `)
  if (type.args) return `${type.name}<${type.args.map(showType).join(", ")}>`
  return type.name
}

/**
 * A value of the type that the settings schema accepts, for the tests. Strings read "a b/c",
 * which passes both as a "provider/model" reference and as a command alias's command line;
 * numbers are 1000, the largest minimum a key has (backgroundJobs.bufferChars).
 */
export function sampleValue(type: Type): unknown {
  if (type.fields) return Object.fromEntries(type.fields.map((f) => [f.name, sampleValue(f.type)]))
  if (type.name === "array") return [sampleValue(type.args![0]!)]
  if (type.name === "Record") return { a: sampleValue(type.args![1]!) }
  if (type.name === "|") return sampleValue(type.args![0]!)
  if (type.name.startsWith('"')) return JSON.parse(type.name)
  if (type.name === "string") return "a b/c"
  if (type.name === "number") return 1000
  if (type.name === "boolean") return true
  if (type.name === "unknown") return {}
  throw new Error(`No sample for type ${type.name}`)
}

export const startMarker = "<!-- settings:generated:start -->"
export const endMarker = "<!-- settings:generated:end -->"

const headers = {
  en: ["Key", "Type", "Default", "Description", "User file only"],
  zh: ["键", "类型", "默认值", "说明", "仅用户文件"],
}

/** The generated block of one document. Throws for a key without reviewed annotations. */
export function renderReference(language: Language, rows = settingsRows()): string {
  const byTop = new Map<string, { key: string; type: string }[]>()
  for (const row of [...rows.map((r) => ({ key: r.key, type: showType(r.type) })), ...extraRows]) {
    const top = row.key.split(".")[0]!
    byTop.set(top, [...(byTop.get(top) ?? []), row])
  }
  const placed = sections.flatMap((s) => s.keys)
  for (const top of byTop.keys()) {
    if (!placed.includes(top)) throw new Error(`Place the top-level key ${top} in a section`)
  }
  for (const top of placed) if (!byTop.has(top)) throw new Error(`Unknown top-level key ${top} in sections`)
  const known = new Set([...byTop.values()].flat().map((r) => r.key))
  for (const key of Object.keys(annotations)) {
    if (!known.has(key)) throw new Error(`Annotation for unknown key ${key}`)
  }
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
  const lines = [
    startMarker,
    "<!-- Generated by scripts/gen-settings-docs.ts; edit that or its data. -->",
    "",
  ]
  for (const section of sections) {
    lines.push(`## ${section.title[language]}`, "")
    if (section.intro) lines.push(section.intro[language], "")
    lines.push(`| ${headers[language].join(" | ")} |`, "| --- | --- | --- | --- | --- |")
    for (const row of section.keys.flatMap((top) => byTop.get(top)!)) {
      const a: Annotation | undefined = annotations[row.key]
      if (!a) throw new Error(`Add a reviewed default, description and translation for ${row.key}`)
      const fallback = typeof a.default === "string" ? a.default : a.default[language]
      const only = a.userOnly ? (language === "en" ? "Yes" : "是") : ""
      lines.push(
        `| \`${cell(row.key)}\` | \`${cell(row.type)}\` | ${cell(fallback)} | ${cell(a[language])} | ${only} |`,
      )
    }
    lines.push("")
  }
  lines.push(endMarker)
  return lines.join("\n")
}

/** The document with its generated block replaced. */
export function updateReference(document: string, generated: string): string {
  const start = document.indexOf(startMarker)
  const end = document.indexOf(endMarker)
  if (start < 0 || end < start || document.indexOf(startMarker, start + 1) >= 0) {
    throw new Error("Expected one settings generated block")
  }
  return document.slice(0, start) + generated + document.slice(end + endMarker.length)
}

if (import.meta.main) {
  const rows = settingsRows()
  let stale = false
  for (const language of ["en", "zh"] as const) {
    const file = path.join(root, docFiles[language])
    const document = readFileSync(file, "utf8").replace(/\r\n/g, "\n")
    const updated = updateReference(document, renderReference(language, rows))
    if (updated === document) continue
    if (process.argv.includes("--check")) {
      console.error(`${docFiles[language]} is stale; run bun scripts/gen-settings-docs.ts`)
      stale = true
    } else writeFileSync(file, updated)
  }
  if (stale) process.exit(1)
}
