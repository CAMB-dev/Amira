import { readFileSync } from "node:fs"
import path from "node:path"
import type { Settings } from "@amira/api"
import { amiraHome, projectAmiraDir } from "../home.ts"
import { deepMerge } from "./merge.ts"
import { SettingsError, validateSettings } from "./schema.ts"

/** Used where no layer sets a value. */
export const DEFAULT_SETTINGS: Settings = {
  shell: "auto",
  tools: { disabled: [] },
  maxParallelTools: 8,
}

export interface SettingsSources {
  cwd: string
  /** The user directory. Default amiraHome(). */
  home?: string
  /** The command-line layer, which wins over every file. */
  flags?: Settings
}

export interface LoadedSettings {
  settings: Settings
  /** Unknown keys and similar problems that do not stop Amira. */
  warnings: string[]
  /** The files that existed and were merged, lowest precedence first. */
  files: string[]
}

/** Settings files from lowest to highest precedence (D35). */
export function settingsFiles(cwd: string, home = amiraHome()): string[] {
  const project = projectAmiraDir(cwd)
  const files = [
    path.join(home, "settings.json"),
    path.join(project, "settings.json"),
    path.join(project, "settings.local.json"),
  ]
  // Run from the home directory, the user and project files are the same file.
  return [...new Set(files)]
}

/**
 * Merges defaults, the settings files and the flags. Throws a SettingsError for a file
 * that is not valid JSON or breaks the schema.
 */
export function loadSettings(src: SettingsSources): LoadedSettings {
  let settings = DEFAULT_SETTINGS
  const warnings: string[] = []
  const files: string[] = []
  const [userFile] = settingsFiles(src.cwd, src.home)
  for (const file of settingsFiles(src.cwd, src.home)) {
    const raw = readJsonFile(file)
    if (raw === undefined) continue
    const v = validateSettings(raw, file)
    warnings.push(...v.warnings)
    if (file !== userFile) {
      warnings.push(...dropProviderEndpoints(v.settings, file, userFile as string))
      warnings.push(...dropWebEndpoints(v.settings, file, userFile as string))
      warnings.push(...dropPackageSettings(v.settings, file, userFile as string))
    }
    settings = deepMerge(settings, v.settings)
    files.push(file)
  }
  // Flags are typed by the argument parser and checked where they are used, so a bad one
  // is reported as a usage error rather than a settings error.
  if (src.flags) settings = deepMerge(settings, src.flags)
  return { settings, warnings, files }
}

/** Provider keys that decide where requests and API keys go. */
const ENDPOINT_KEYS = ["baseUrl", "apiKeyEnv", "apiKeyEnvFallbacks", "headers"] as const

/**
 * A project file travels with the repository, so it must not choose where requests and
 * API keys are sent: those provider keys are removed, with a warning for each.
 */
function dropProviderEndpoints(settings: Settings, file: string, userFile: string): string[] {
  const warnings: string[] = []
  for (const [id, entry] of Object.entries(settings.providers ?? {})) {
    for (const key of ENDPOINT_KEYS) {
      if (entry[key] === undefined) continue
      delete entry[key]
      warnings.push(
        `${file}: "providers.${id}.${key}" is ignored; a project file cannot change where requests and API keys go. Set it in ${userFile} instead`,
      )
    }
  }
  return warnings
}

/**
 * Likewise for the web tools: a project file must not send searches (or a key) to a server
 * of its choosing, nor let web_fetch reach the private network.
 */
function dropWebEndpoints(settings: Settings, file: string, userFile: string): string[] {
  const warnings: string[] = []
  const drop = (obj: Record<string, unknown> | undefined, at: string, keys: string[]) => {
    for (const key of keys) {
      if (!obj || obj[key] === undefined) continue
      delete obj[key]
      warnings.push(
        `${file}: "${at}.${key}" is ignored; a project file cannot change where web requests go. Set it in ${userFile} instead`,
      )
    }
  }
  const search = settings.web?.search
  drop(search?.exa, "web.search.exa", ["url", "apiKeyEnv"])
  drop(search?.brave, "web.search.brave", ["apiKeyEnv"])
  drop(search?.tavily, "web.search.tavily", ["apiKeyEnv"])
  drop(search?.searxng, "web.search.searxng", ["url"])
  drop(settings.web?.fetch, "web.fetch", ["allowPrivateNetwork"])
  return warnings
}

/**
 * Nor may a project file say that projects are trusted to run their own packages, or which
 * packages load: lists replace each other when settings merge, so a project file could turn a
 * package the user disabled back on, or turn off one the user relies on (e.g. a permission
 * policy). `amira ext disable|enable|trust|untrust` write the user file.
 */
function dropPackageSettings(settings: Settings, file: string, userFile: string): string[] {
  const warnings: string[] = []
  for (const key of ["disabled", "trustedProjects", "untrustedProjects"] as const) {
    if (settings.packages?.[key] === undefined) continue
    delete settings.packages[key]
    const why =
      key === "disabled"
        ? "a project file cannot choose which packages load"
        : "a project file cannot decide which projects are trusted"
    warnings.push(`${file}: "packages.${key}" is ignored; ${why}. Set it in ${userFile} instead`)
  }
  return warnings
}

/** Parses a JSON file; undefined if it does not exist. */
export function readJsonFile(file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new SettingsError(file, [`cannot be read: ${err instanceof Error ? err.message : String(err)}`])
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""))
  } catch (err) {
    throw new SettingsError(file, [`is not valid JSON: ${err instanceof Error ? err.message : String(err)}`])
  }
}
