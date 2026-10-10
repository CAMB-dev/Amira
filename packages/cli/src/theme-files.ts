import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { ThemeDefinition } from "@amira/api"
import type { ThemeFileEntry, ThemeRegistry } from "@amira/core"
import amber from "../themes/amber.json"
import amira from "../themes/amira.json"
import ascii from "../themes/ascii.json"
import burnt from "../themes/burnt.json"
import lavender from "../themes/lavender.json"
import mono from "../themes/mono.json"

// Static imports keep the definitions inside bundled and compiled CLI releases.
export const builtinThemes: readonly ThemeDefinition[] = [
  amira,
  amber,
  burnt,
  lavender,
  mono,
  ascii,
] as ThemeDefinition[]

export interface ThemeFilesOptions {
  /** The Amira user directory, not the OS home. No implicit real-home reads. */
  home: string
  /** The starting working directory, never the Git root. */
  cwd: string
  /** Absolute JSON paths contributed by active, trusted package manifests. */
  packageThemes?: readonly string[]
}

export interface ThemeFilesResult {
  /** Complete file snapshot in precedence order, including the built-ins. */
  entries: ThemeFileEntry[]
  /** Read and JSON errors. Validation and replacement notices go through the registry. */
  notices: string[]
}

/** Loads a fresh snapshot without disturbing extension registrations. Bad files never abort it. */
export function loadThemeFiles(registry: ThemeRegistry, opts: ThemeFilesOptions): ThemeFilesResult {
  const entries: ThemeFileEntry[] = builtinThemes
    .toSorted((a, b) => compare(a.name, b.name))
    .map((theme) => ({ theme, source: "built-in", origin: `builtin:${theme.name}` }))
  const notices: string[] = []
  const load = (file: string, source: "user" | "project" | "package") => {
    try {
      // Registry validation is shared with registerTheme; do not maintain another validator here.
      const theme: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
      entries.push({ theme: theme as ThemeDefinition, source, origin: file })
    } catch (error) {
      notices.push(`${file}: unable to load theme; ${message(error)} (skipped)`)
    }
  }
  const directory = (dir: string, source: "user" | "project") => {
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort(compare)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        notices.push(`${dir}: unable to read themes; ${message(error)} (skipped)`)
      return
    }
    for (const name of names) load(path.join(dir, name), source)
  }
  directory(path.join(opts.home, "themes"), "user")
  directory(path.join(opts.cwd, ".amira", "themes"), "project")
  // Active package order and each manifest's declared path order determine precedence.
  for (const file of opts.packageThemes ?? []) load(file, "package")
  registry.replaceFiles(entries)
  return { entries, notices }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
