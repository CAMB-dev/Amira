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
  for (const file of settingsFiles(src.cwd, src.home)) {
    const raw = readJsonFile(file)
    if (raw === undefined) continue
    const v = validateSettings(raw, file)
    settings = deepMerge(settings, v.settings)
    warnings.push(...v.warnings)
    files.push(file)
  }
  if (src.flags) {
    const v = validateSettings(src.flags, "command line")
    settings = deepMerge(settings, v.settings)
    warnings.push(...v.warnings)
  }
  return { settings, warnings, files }
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
