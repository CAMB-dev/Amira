import path from "node:path"
import { findPreset, PROVIDER_PRESETS, type ProviderConfig } from "@amira/ai"
import type { ProviderSettings } from "@amira/api"
import { addProviderToSettings, amiraHome } from "@amira/core"
import { UsageError } from "./args.ts"
import type { PrintIO } from "./print.ts"

const USAGE = `Usage:
  amira provider presets [id]   Print settings.json entries for known providers
  amira provider add <id>       Add a preset to the user settings.json

Presets: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}`

/** `amira provider ...`: presets for providers that are not built in (D53, D54). */
export function runProviderCommand(argv: string[], io: PrintIO, home = amiraHome()): number {
  const [sub, id, ...rest] = argv
  if (sub === "presets" && rest.length === 0) {
    const presets = id ? [preset(id)] : PROVIDER_PRESETS
    const snippet = { providers: Object.fromEntries(presets.map((p) => [p.id, toSettings(p)])) }
    io.stdout(`${JSON.stringify(snippet, null, 2)}\n`)
    return 0
  }
  if (sub === "add" && id && rest.length === 0) {
    const p = preset(id)
    const file = path.join(home, "settings.json")
    if (addProviderToSettings(file, p.id, toSettings(p)) === "exists") {
      io.stdout(`Provider "${p.id}" is already in ${file}; left it unchanged.\n`)
      return 0
    }
    io.stdout(`Added provider "${p.id}" to ${file}.\n`)
    if (p.apiKeyEnv) {
      io.stdout(
        `Set ${p.apiKeyEnv}, or store the key in ${path.join(home, "auth.json")} as ` +
          `{"${p.id}": {"apiKey": "..."}}.\n`,
      )
    }
    io.stdout(`Then run: amira -m ${p.id}/<model>\n`)
    return 0
  }
  if (sub === "help") {
    io.stdout(`${USAGE}\n`)
    return 0
  }
  const what = sub ? `unknown provider command "${argv.join(" ")}"` : "missing provider command"
  throw new UsageError(`${what}\n\n${USAGE}`)
}

function preset(id: string): ProviderConfig {
  const p = findPreset(id)
  if (!p) throw new UsageError(`no preset "${id}"; presets: ${PROVIDER_PRESETS.map((x) => x.id).join(", ")}`)
  return p
}

function toSettings({ id: _id, ...rest }: ProviderConfig): ProviderSettings {
  return rest
}

/** Adds a hint to an unknown-provider error when a preset of that name exists. */
export function withPresetHint(ref: string, message: string): string {
  const id = ref.slice(0, ref.indexOf("/"))
  if (!message.startsWith("unknown provider")) return message
  if (findPreset(id)) return `${message}; add it with: amira provider add ${id}`
  return `${message}; see amira provider presets, or add it to settings.json`
}
