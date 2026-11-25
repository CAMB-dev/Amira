// Owns the interactive /settings GUI command, live preview state, and rollback/persistence.
import type { CommandContext, CommandDefinition, TuiSettings } from "@amira/api"
import { reloadClockSetting } from "../clock.ts"
import {
  defaultEditableSettings,
  diffEditableSettings,
  type EditableTuiSettings,
  resolveEditableSettings,
  SETTINGS_FIELDS,
  SettingsMenuDialog,
} from "../settings-menu.ts"
import type { TerminalStatus } from "../terminal-status.ts"
import type { OverlayManager } from "./overlays.ts"
import type { RuntimeThemes } from "./themes.ts"

export interface SettingsCommandDeps {
  settings: TuiSettings
  overlays: OverlayManager
  themes: RuntimeThemes
  termStatus: TerminalStatus
  viewport: () => { columns: number; rows: number }
  saveTuiSettings?: (patch: Partial<TuiSettings>) => void | Promise<void>
  requestRender: () => void
  redraw: () => void
}

function applyEditableToLive(
  target: TuiSettings,
  next: Required<EditableTuiSettings>,
  deps: Pick<SettingsCommandDeps, "themes" | "termStatus" | "requestRender" | "redraw">,
): void {
  const layoutChanged = target.margin !== next.margin || target.marginRows !== next.marginRows
  Object.assign(target, next)
  reloadClockSetting(next.clock)
  deps.themes.setColorDepth(next.colorDepth)
  deps.termStatus.updateOptions({
    bell: next.bell,
    notify: next.notify,
    title: next.title,
    progress: next.progress,
  })
  if (layoutChanged) deps.redraw()
  else deps.requestRender()
}

function summarizePatch(patch: Partial<TuiSettings>): string {
  const entries = Object.entries(patch)
  if (!entries.length) return "Settings unchanged."
  const parts = entries.map(([key, value]) => {
    const label = SETTINGS_FIELDS.find((f) => f.key === key)?.label ?? key
    const shown = typeof value === "boolean" ? (value ? "on" : "off") : String(value)
    return `${label}: ${shown}`
  })
  return `Settings saved — ${parts.join(", ")}`
}

/** Built-in /settings command: clickable GUI button menu with live preview, plus quick subcommands. */
export function settingsCommand(deps: SettingsCommandDeps): CommandDefinition {
  return {
    name: "settings",
    description: "Open interactive GUI settings menu with live preview (margin, layout, interface, alerts)",
    args: {
      hint: "[margin <0-12> | marginRows <0-2> | reset]",
      complete: () => [
        { value: "margin", description: "set side margin in cells (0–12)" },
        { value: "marginRows", description: "set top/bottom margin in rows (0–2)" },
        { value: "reset", description: "reset TUI settings to defaults" },
      ],
    },
    run: async (rawArgs, ctx) => {
      if (ctx.frontend !== "tui") {
        ctx.print("/settings only changes the interactive terminal UI.", "warning")
        return
      }
      const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
      if (parts.length > 0) {
        await runDirect(parts, ctx, deps)
        return
      }
      if (deps.overlays.hasFullscreen || deps.overlays.dialogs.length) {
        ctx.print("Close the current dialog or view before opening settings.", "warning")
        return
      }
      await openSettingsMenu(ctx, deps)
    },
  }
}

async function runDirect(parts: string[], ctx: CommandContext, deps: SettingsCommandDeps): Promise<void> {
  const [sub, rawValue] = parts
  const current = resolveEditableSettings(deps.settings)
  if (sub === "reset") {
    const defaults = defaultEditableSettings()
    const patch = diffEditableSettings(current, defaults)
    applyEditableToLive(deps.settings, defaults, deps)
    if (Object.keys(patch).length) await deps.saveTuiSettings?.(patch)
    ctx.print(
      Object.keys(patch).length ? "TUI settings reset to defaults." : "Settings are already at defaults.",
    )
    return
  }
  if (sub === "margin" || sub === "marginRows") {
    const min = 0
    const max = sub === "margin" ? 12 : 2
    if (rawValue === undefined) {
      ctx.print(`${sub}: ${current[sub]} (range ${min}–${max})`)
      return
    }
    const parsed = Number(rawValue)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      ctx.print(`${sub} must be an integer between ${min} and ${max}.`, "error")
      return
    }
    const next = { ...current, [sub]: parsed }
    applyEditableToLive(deps.settings, next, deps)
    await deps.saveTuiSettings?.({ [sub]: parsed })
    ctx.print(summarizePatch({ [sub]: parsed }))
    return
  }
  ctx.print("Usage: /settings [margin <0-12> | marginRows <0-2> | reset]", "warning")
}

function openSettingsMenu(ctx: CommandContext, deps: SettingsCommandDeps): Promise<void> {
  const snapshot = { ...deps.settings }
  const initial = resolveEditableSettings(snapshot)
  return new Promise<void>((resolve, reject) => {
    let finished = false
    let close: (() => void) | undefined
    const cleanup = () => {
      ctx.signal.removeEventListener("abort", cancel)
      close?.()
    }
    const restore = () => {
      for (const field of SETTINGS_FIELDS) {
        if (snapshot[field.key] === undefined) delete deps.settings[field.key]
        else Object.assign(deps.settings, { [field.key]: snapshot[field.key] })
      }
      applyEditableToLive(deps.settings, initial, deps)
      // Preserve omitted keys exactly as they started.
      for (const field of SETTINGS_FIELDS) {
        if (snapshot[field.key] === undefined) delete deps.settings[field.key]
      }
    }
    const cancel = () => {
      if (finished) return
      finished = true
      cleanup()
      restore()
      resolve()
    }
    const dialog = new SettingsMenuDialog({
      initial: snapshot,
      viewport: deps.viewport,
      onPreview: (draft) => {
        applyEditableToLive(deps.settings, draft, deps)
      },
      onSave: (patch, draft) => {
        if (finished) return
        finished = true
        cleanup()
        applyEditableToLive(deps.settings, draft, deps)
        Promise.resolve()
          .then(() => (Object.keys(patch).length ? deps.saveTuiSettings?.(patch) : undefined))
          .then(() => {
            ctx.print(summarizePatch(patch))
            resolve()
          }, reject)
      },
      onCancel: cancel,
    })
    if (ctx.signal.aborted) return cancel()
    ctx.signal.addEventListener("abort", cancel, { once: true })
    close = deps.overlays.openLocalDialog(dialog)
  })
}
