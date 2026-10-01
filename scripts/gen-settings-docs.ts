import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { annotations, mcpFields } from "./settings-docs-data.ts"

export const root = fileURLToPath(new URL("../", import.meta.url))
export const typeFiles = [
  "packages/api/src/settings.ts",
  "packages/api/src/subagents.ts",
  "packages/ai/src/providers.ts",
  "packages/ai/src/dialect.ts",
  "packages/ai/src/types.ts",
]

interface Field {
  name: string
  optional: boolean
  doc: string
  type: Type
}
interface Type {
  name: string
  args?: Type[]
  fields?: Field[]
}
export interface Row {
  key: string
  type: string
  optional: boolean
  doc: string
}

// A type-only grammar: interfaces, inheritance, literals, unions/intersections, arrays,
// Record, Partial and Omit. Unsupported syntax fails instead of silently losing fields.
class Parser {
  readonly tokens: string[]
  pos = 0

  constructor(source: string) {
    this.tokens = source.match(/\/\*[^]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\w+|[^\s]/g) ?? []
    this.tokens = this.tokens.filter((t) => !t.startsWith("//") || t.startsWith("/**"))
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

  doc(): string {
    let doc = ""
    while (this.peek()?.startsWith("/*")) {
      const comment = this.take()
      if (comment.startsWith("/**")) {
        doc = comment.slice(3, -2).replace(/^\s*\* ?/gm, "").replace(/\s+/g, " ").trim()
      }
    }
    return doc
  }

  type(): Type {
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
      if (!/^(\w+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(name)) {
        throw new Error(`Unsupported type token ${name}`)
      }
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
      const doc = this.doc()
      if (this.peek() === "}") break
      const name = this.take()
      if (!/^\w+$/.test(name)) throw new Error(`Unsupported property ${name}`)
      const optional = this.peek() === "?"
      if (optional) this.take()
      this.take(":")
      fields.push({ name, optional, doc, type: this.type() })
      if (this.peek() === ";" || this.peek() === ",") this.take()
    }
    this.take("}")
    return fields
  }
}

export function settingsRows(sources = typeFiles.map((file) => readFileSync(path.join(root, file), "utf8"))) {
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
        parser.take()
        parents.push(parser.type())
        while (parser.peek() === ",") {
          parser.take()
          parents.push(parser.type())
        }
      }
      type = { name: "object", fields: [...parents.flatMap(fields), ...parser.fields()] }
    }
    cache.set(name, type)
    resolving.delete(name)
    return type
  }
  const fields = (type: Type): Field[] => {
    if (type.fields) return type.fields
    if (type.name === "&") return type.args!.flatMap(fields)
    if (type.name === "Partial") return fields(type.args![0]!).map((f) => ({ ...f, optional: true }))
    if (type.name === "Omit") {
      const excluded = type.args![1]!
      const names = (excluded.name === "|" ? excluded.args! : [excluded]).map((t) => t.name.slice(1, -1))
      return fields(type.args![0]!).filter((f) => !names.includes(f.name))
    }
    return fields(resolve(type.name))
  }
  const display = (type: Type): string => {
    if (type.name === "object") {
      return `{ ${type.fields!.map((f) => `${f.name}${f.optional ? "?" : ""}: ${display(f.type)}`).join("; ")} }`
    }
    if (type.name === "array") return `${display(type.args![0]!)}[]`
    if (type.name === "|" || type.name === "&") return type.args!.map(display).join(` ${type.name} `)
    if (type.args) return `${type.name}<${type.args.map(display).join(", ")}>`
    if (["ShellMode", "EditingTool", "WebSearchBackend", "ContextWindowSource"].includes(type.name)) {
      return display(resolve(type.name))
    }
    return type.name
  }
  const rows: Row[] = []
  const walk = (type: Type, key: string) => {
    if (type.name === "array") return walk(type.args![0]!, `${key}[]`)
    if (type.name === "Record") {
      const variable = key === "providers" ? "id" : key === "agents" ? "role" : key === "commandAliases" ? "alias" : "name"
      const value = type.args![1]!
      if (value.name === "string" || (value.name === "Record" && value.args![1]?.name === "unknown")) return
      return walk(value, `${key}.<${variable}>`)
    }
    if (["string", "number", "boolean", "unknown", "false", "|"].includes(type.name)) return
    if (type.name.startsWith('"') || type.name.startsWith("'")) return
    for (const field of fields(type)) {
      const at = key ? `${key}.${field.name}` : field.name
      rows.push({ key: at, type: display(field.type), optional: field.optional, doc: field.doc })
      walk(field.type, at)
    }
  }
  walk(resolve("Settings"), "")
  return rows
}

export const startMarker = "<!-- settings:generated:start -->"
export const endMarker = "<!-- settings:generated:end -->"

export function renderReference(language: "en" | "zh", rows = settingsRows()): string {
  const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex")
  const lines = [startMarker, `<!-- Types and JSDoc: ${digest} -->`, ""]
  let section = ""
  for (const row of [...rows, ...mcpFields]) {
    const top = row.key.split(".")[0]!
    if (top !== section) {
      section = top
      lines.push(`## ${top}`, "", language === "en"
        ? "| Key | Type | Default | Description | User-only? |"
        : "| Key | Type | 默认值 | 说明 | 仅限用户设置？ |", "| --- | --- | --- | --- | --- |")
    }
    const normalized = row.key.replace(/providers\.<id>\.(models\[\]|defaultModel)/, "model")
    const annotation = annotations[row.key] ?? annotations[normalized]
    if (!annotation) throw new Error(`Add reviewed defaults and a translation for ${row.key}`)
    const [fallback, en, zh, userOnly] = annotation
    const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
    const description = language === "en" ? en || row.doc : zh
    if (!description) throw new Error(`Missing description for ${row.key}`)
    const only = userOnly ? (language === "en" ? "Yes" : "是") : (language === "en" ? "No" : "否")
    lines.push(`| \`${escape(row.key)}\` | \`${escape(row.type)}\` | ${fallback} | ${escape(description)} | ${only} |`)
    if (row === rows.at(-1) || row === mcpFields.at(-1) || rows[rows.indexOf(row) + 1]?.key.split(".")[0] !== top) lines.push("")
  }
  lines.push(endMarker)
  return lines.join("\n")
}

export function updateReference(document: string, generated: string): string {
  const start = document.indexOf(startMarker)
  const end = document.indexOf(endMarker)
  if (start < 0 || end < start || document.indexOf(startMarker, start + 1) >= 0) {
    throw new Error("Expected one settings generated block")
  }
  return document.slice(0, start) + generated + document.slice(end + endMarker.length)
}

if (import.meta.main) {
  for (const language of ["en", "zh"] as const) {
    const file = path.join(root, language === "en" ? "docs/settings.md" : "docs/zh/settings.md")
    const document = readFileSync(file, "utf8").replace(/\r\n/g, "\n")
    const updated = updateReference(document, renderReference(language))
    if (process.argv.includes("--check")) {
      if (updated !== document) throw new Error(`${path.relative(root, file)} is stale; run bun scripts/gen-settings-docs.ts`)
    } else writeFileSync(file, updated)
  }
}
