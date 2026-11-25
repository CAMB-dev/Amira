// Owns the fullscreen tabbed /settings GUI command, live preview state, and rollback/persistence.
import type { CommandContext, CommandDefinition, ShimmerEffect, TuiSettings } from "@amira/api"
import type { ThemeVariant } from "@amira/tui-kit"
import { reloadClockSetting } from "../clock.ts"
import {
  defaultEditableSettings,
  diffEditableSettings,
  type EditableTuiSettings,
  type FloatingPreviewKind,
  resolveEditableSettings,
  SETTINGS_FIELDS,
  type SettingsSectionId,
  SettingsView,
  shimmerEffectFromChoice,
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
  saveTheme?: (name: string, variant: ThemeVariant, shimmer?: ShimmerEffect) => void | Promise<void>
  saveTuiSettings?: (patch: Partial<TuiSettings>) => void | Promise<void>
  requestRender: () => void
  redraw: () => void
}

const SECTION_ALIASES: Record<string, SettingsSectionId> = {
  layout: "layout",
  display: "layout",
  theme: "appearance",
  appearance: "appearance",
  behavior: "behavior",
  input: "behavior",
  alerts: "alerts",
  terminal: "alerts",
}

function applyEditableToLive(
  target: TuiSettings,
  next: EditableTuiSettings,
  originalShimmer: ShimmerEffect | undefined,
  previewingTheme: boolean,
  deps: Pick<SettingsCommandDeps, "themes" | "termStatus" | "requestRender" | "redraw">,
): void {
  const layoutChanged = target.margin !== next.margin || target.marginRows !== next.marginRows
  const shimmer = shimmerEffectFromChoice(next.shimmer, originalShimmer)
  Object.assign(target, {
    margin: next.margin,
    marginRows: next.marginRows,
    shellOutputLines: next.shellOutputLines,
    theme: next.theme,
    themeVariant: next.themeVariant,
    colorDepth: next.colorDepth,
    shimmer,
    images: next.images,
    submitWhileWorking: next.submitWhileWorking,
    clock: next.clock,
    tokenSpeed: next.tokenSpeed,
    bell: next.bell,
    notify: next.notify,
    title: next.title,
    progress: next.progress,
  })
  reloadClockSetting(next.clock)
  deps.themes.applyAppearance({
    theme: next.theme,
    themeVariant: next.themeVariant,
    shimmer,
    colorDepth: next.colorDepth,
    previewing: previewingTheme,
  })
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
    const shown =
      value === undefined
        ? "theme"
        : typeof value === "boolean"
          ? value
            ? "on"
            : "off"
          : typeof value === "object"
            ? "custom"
            : String(value)
    return `${label}: ${shown}`
  })
  return `Settings saved — ${parts.join(", ")}`
}

/** Built-in /settings command: fullscreen tabbed GUI with live Layout & Theme previews, plus quick subcommands. */
export function settingsCommand(deps: SettingsCommandDeps): CommandDefinition {
  return {
    name: "settings",
    description: "Open fullscreen tabbed settings with live Layout & Theme previews",
    args: {
      hint: "[layout | theme | behavior | alerts | preview | margin <0-12> | marginRows <0-2> | reset]",
      complete: () => [
        { value: "layout", description: "open Layout & Display tab" },
        { value: "theme", description: "open Theme & Appearance tab" },
        { value: "behavior", description: "open Behavior & Input tab" },
        { value: "alerts", description: "open Alerts & Terminal tab" },
        { value: "preview", description: "open translucent live Layout preview over chat" },
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
      const first = parts[0]?.toLowerCase()
      const directPreview: FloatingPreviewKind | undefined =
        parts.length === 1 && first === "preview" ? "layout" : undefined
      const directSection = parts.length === 1 && first ? SECTION_ALIASES[first] : undefined
      if (parts.length > 0 && !directSection && !directPreview) {
        await runDirect(parts, ctx, deps)
        return
      }
      if (deps.overlays.hasFullscreen || deps.overlays.dialogs.length) {
        ctx.print("Close the current dialog or view before opening settings.", "warning")
        return
      }
      await openSettingsView(ctx, deps, directSection, directPreview)
    },
  }
}

async function persistPatch(
  patch: Partial<TuiSettings>,
  draft: EditableTuiSettings,
  originalShimmer: ShimmerEffect | undefined,
  deps: Pick<SettingsCommandDeps, "saveTheme" | "saveTuiSettings">,
): Promise<void> {
  if (!Object.keys(patch).length) return
  const themeChanged = "theme" in patch || "themeVariant" in patch || "shimmer" in patch
  if (themeChanged && deps.saveTheme) {
    const rest: Partial<TuiSettings> = { ...patch }
    delete rest.theme
    delete rest.themeVariant
    delete rest.shimmer
    if ("shimmer" in patch) {
      await deps.saveTheme(
        draft.theme,
        draft.themeVariant,
        shimmerEffectFromChoice(draft.shimmer, originalShimmer),
      )
    } else {
      await deps.saveTheme(draft.theme, draft.themeVariant)
    }
    if (Object.keys(rest).length) await deps.saveTuiSettings?.(rest)
    return
  }
  await deps.saveTuiSettings?.(patch)
}

async function runDirect(parts: string[], ctx: CommandContext, deps: SettingsCommandDeps): Promise<void> {
  const [sub, rawValue] = parts
  const runtimeTheme = {
    name: deps.themes.current.name,
    themeVariant: deps.themes.current.themeVariant,
    shimmer: deps.themes.shimmerOverride,
  }
  const current = resolveEditableSettings(deps.settings, runtimeTheme)
  if (sub === "reset") {
    const defaults = defaultEditableSettings()
    const patch = diffEditableSettings(current, defaults, runtimeTheme.shimmer)
    applyEditableToLive(deps.settings, defaults, undefined, false, deps)
    await persistPatch(patch, defaults, undefined, deps)
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
    applyEditableToLive(deps.settings, next, runtimeTheme.shimmer, false, deps)
    await deps.saveTuiSettings?.({ [sub]: parsed })
    ctx.print(summarizePatch({ [sub]: parsed }))
    return
  }
  ctx.print(
    "Usage: /settings [layout | theme | behavior | alerts | preview | margin <0-12> | marginRows <0-2> | reset]",
    "warning",
  )
}

function openSettingsView(
  ctx: CommandContext,
  deps: SettingsCommandDeps,
  initialSection?: SettingsSectionId,
  initialPreview?: FloatingPreviewKind,
): Promise<void> {
  const snapshot = { ...deps.settings }
  const runtimeTheme = {
    name: deps.themes.current.name,
    themeVariant: deps.themes.current.themeVariant,
    shimmer: deps.themes.shimmerOverride,
  }
  const initial = resolveEditableSettings(snapshot, runtimeTheme)
  return new Promise<void>((resolve, reject) => {
    let finished = false
    let close: (() => void) | undefined
    const cleanup = () => {
      ctx.signal.removeEventListener("abort", cancel)
      close?.()
    }
    const restore = () => {
      applyEditableToLive(deps.settings, initial, runtimeTheme.shimmer, false, deps)
      for (const field of SETTINGS_FIELDS) {
        if (snapshot[field.key as keyof TuiSettings] === undefined) {
          delete deps.settings[field.key as keyof TuiSettings]
        }
      }
    }
    const cancel = () => {
      if (finished) return
      finished = true
      cleanup()
      restore()
      resolve()
    }
    const view = new SettingsView({
      initial: snapshot,
      runtimeTheme,
      themeNames: deps.themes.listThemeNames(),
      initialSection,
      initialPreview,
      viewport: deps.viewport,
      onPreview: (draft, mode) => {
        applyEditableToLive(
          deps.settings,
          draft,
          runtimeTheme.shimmer,
          mode.tab === "appearance" || mode.floating === "appearance",
          deps,
        )
      },
      onSave: (patch, draft) => {
        if (finished) return
        finished = true
        cleanup()
        applyEditableToLive(deps.settings, draft, runtimeTheme.shimmer, false, deps)
        Promise.resolve()
          .then(() => persistPatch(patch, draft, runtimeTheme.shimmer, deps))
          .then(() => {
            ctx.print(summarizePatch(patch))
            resolve()
          }, reject)
      },
      onCancel: cancel,
    })
    if (ctx.signal.aborted) return cancel()
    ctx.signal.addEventListener("abort", cancel, { once: true })
    close = deps.overlays.openLocalOverlay(view)
  })
}
