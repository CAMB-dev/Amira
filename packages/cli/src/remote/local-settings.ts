import { readFileSync } from "node:fs"
import path from "node:path"
import {
  amiraHome,
  authFile,
  loadAuth,
  providersFromSettings,
  ThemeRegistry,
  validateSettings,
} from "@amira/core"
import { loadKeybindings, PromptHistory } from "@amira/tui"
import { loadThemeFiles } from "../theme-files.ts"

/** User-only local presentation and credential bindings. No project settings/instructions or extensions. */
export function loadRemoteLocalSettings(home = amiraHome()) {
  const file = path.join(home, "settings.json")
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const { settings, warnings } = validateSettings(raw, file)
  const keys = loadKeybindings(path.join(home, "keybindings.json"))
  warnings.push(...keys.warnings)
  const themes = new ThemeRegistry((notice) => warnings.push(notice))
  warnings.push(...loadThemeFiles(themes, { home, cwd: process.cwd(), project: false }).notices)
  return {
    home,
    settings: settings.tui,
    themes,
    keybindings: keys.keys,
    // Remote prompts stay in memory; no local per-project transcript/history copy.
    history: new PromptHistory(),
    warnings,
    credentials: () => {
      const auth = loadAuth(authFile(home))
      return { providers: providersFromSettings(settings.providers, warnings), apiKeys: auth.keys }
    },
  }
}
