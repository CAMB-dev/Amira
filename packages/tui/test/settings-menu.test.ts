import { describe, expect, test } from "bun:test"
import type { ShimmerEffect, TuiSettings } from "@amira/api"
import {
  defaultTheme,
  key,
  type MouseInput,
  type RenderContext,
  stripAnsi,
  visibleWidth,
} from "@amira/tui-kit"
import { SettingsMenuDialog } from "../src/settings-menu.ts"
import { setup, waitFor } from "./app-harness.ts"

const ctx: RenderContext = { theme: defaultTheme, color: true, rows: 36 }

function mouse(
  x: number,
  y: number,
  action: MouseInput["action"],
  button: MouseInput["button"] = "left",
): MouseInput {
  return { type: "mouse", x, y, action, button, ctrl: false, alt: false, shift: false }
}

function findCell(rows: string[], text: string, offset = 2): { x: number; y: number } {
  const y = rows.findIndex((row) => stripAnsi(row).includes(text))
  if (y === -1) throw new Error(`Target not found: ${text}\n${rows.map(stripAnsi).join("\n")}`)
  const plain = stripAnsi(rows[y]!)
  return { x: visibleWidth(plain.slice(0, plain.indexOf(text))) + offset, y }
}

function click(dialog: SettingsMenuDialog, rows: string[], text: string, offset = 2): void {
  const pt = findCell(rows, text, offset)
  dialog.handleInput(mouse(pt.x, pt.y, "press"))
  dialog.handleInput(mouse(pt.x, pt.y, "release"))
}

describe("SettingsMenuDialog (hierarchical menu)", () => {
  test("drills from Home into Layout, Theme & Appearance, Behavior and Alerts, previews live and saves", () => {
    const previews: { margin: number; theme: string; view: string }[] = []
    let savedPatch: Partial<TuiSettings> | undefined
    let cancelled = 0
    const dialog = new SettingsMenuDialog({
      initial: { margin: 1, marginRows: 0 },
      themeNames: ["amira", "amber", "burnt", "lavender", "mono", "ascii", "terminal"],
      viewport: () => ({ columns: 120, rows: 36 }),
      onPreview: (draft, view) => previews.push({ margin: draft.margin, theme: draft.theme, view }),
      onSave: (patch) => {
        savedPatch = patch
      },
      onCancel: () => {
        cancelled++
      },
    })

    // Level 0: Home shows all 4 hierarchical categories with live summaries.
    let rows = dialog.render(100, ctx)
    let text = rows.map(stripAnsi).join("\n")
    expect(dialog.activeView).toBe("home")
    expect(text).toContain("Layout & Display")
    expect(text).toContain("Theme & Appearance")
    expect(text).toContain("Behavior & Input")
    expect(text).toContain("Alerts & Terminal")
    expect(text).toContain("118×36 (margin 1, rows 0)")

    // Drill into Layout & Display by clicking the category row.
    click(dialog, rows, "Layout & Display")
    expect(dialog.activeView).toBe("layout")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ 4 ]")
    expect(dialog.draft.margin).toBe(4)
    expect(previews.at(-1)).toMatchObject({ margin: 4, view: "layout" })
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ + ]")
    expect(dialog.draft.margin).toBe(5)

    // Click breadcrumb [ ← Settings ] to go back to Home; Layout shows * dirty marker & updated summary.
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ ← Settings ]")
    expect(dialog.activeView).toBe("home")
    rows = dialog.render(100, ctx)
    text = rows.map(stripAnsi).join("\n")
    expect(text).toContain("Layout & Display*")
    expect(text).toContain("margin 5")

    // Drill into Theme & Appearance (theme, appearance, colorDepth, shimmer, images live here!).
    click(dialog, rows, "Theme & Appearance")
    expect(dialog.activeView).toBe("appearance")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ lavender ]")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ light ]")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ 256 ]")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ › ]")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ › ]")
    expect(dialog.draft.theme).toBe("lavender")
    expect(dialog.draft.themeVariant).toBe("light")
    expect(dialog.draft.colorDepth).toBe("256")
    expect(dialog.draft.shimmer).toBe("soft")

    // Jump via quick section pill to Behavior, then Alerts.
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ Behavior ]")
    expect(dialog.activeView).toBe("behavior")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ queue ]")
    click(dialog, rows, "[ 24h ]")

    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ Alerts ]")
    expect(dialog.activeView).toBe("alerts")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ Off ]")

    // Save changes directly from sub-page.
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ Save changes ]")
    expect(cancelled).toBe(0)
    expect(savedPatch).toEqual({
      margin: 5,
      theme: "lavender",
      themeVariant: "light",
      colorDepth: "256",
      shimmer: "soft",
      submitWhileWorking: "queue",
      clock: "24h",
      bell: false,
    })
  })

  test("Esc pops from sub-page back to Home, and Esc at Home cancels and restores without saving", () => {
    let saved = 0
    let cancelled = 0
    const dialog = new SettingsMenuDialog({
      initial: { margin: 2 },
      initialSection: "layout",
      onPreview: () => {},
      onSave: () => {
        saved++
      },
      onCancel: () => {
        cancelled++
      },
    })
    const rows = dialog.render(100, ctx)
    click(dialog, rows, "[ 6 ]")
    expect(dialog.draft.margin).toBe(6)
    expect(dialog.activeView).toBe("layout")

    // First Esc pops back to Settings Home (does not cancel yet).
    dialog.handleInput(key("escape"))
    expect(dialog.activeView).toBe("home")
    expect(cancelled).toBe(0)

    // Second Esc at Home cancels and restores.
    dialog.handleInput(key("escape"))
    expect(saved).toBe(0)
    expect(cancelled).toBe(1)
  })
})

test("/settings previews live margin & theme changes, restores on Esc, and persists both on Save", async () => {
  const savedSettings: Partial<TuiSettings>[] = []
  const savedThemes: { name: string; variant: string; shimmer?: ShimmerEffect }[] = []
  const app = await setup([], {
    commands: [],
    tuiCommands: true,
    cols: 110,
    rows: 34,
    settings: { margin: 1, marginRows: 0, theme: "dark", colorDepth: "truecolor" },
    saveTheme: (name, variant, shimmer) => {
      savedThemes.push({ name, variant, shimmer })
    },
    saveTuiSettings: (patch) => {
      savedSettings.push(patch)
    },
  })
  const clickText = (text: string) => {
    const y = app.screen.lines.findIndex((line) => line.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    const x = app.screen.lines[y]!.indexOf(text) + 2
    app.terminal.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
  }
  const topBorderIndent = () => {
    const line = app.screen.lines.find((l) => l.includes("╭─ Settings"))
    expect(line).toBeDefined()
    return line!.indexOf("╭")
  }
  try {
    // 1. Open /settings Home -> click Layout & Display -> preview margin 6 -> Esc back to Home -> Esc restore.
    app.terminal.send("/settings\r")
    await waitFor(() => app.live().includes("Layout & Display"), "settings home opened")
    expect(topBorderIndent()).toBe(1)

    clickText("Layout & Display")
    await waitFor(() => app.live().includes("Side margin"), "drilled into layout")
    clickText("[ 6 ]")
    await waitFor(() => topBorderIndent() === 6, "live margin=6 preview")
    expect(savedSettings).toEqual([])

    // Esc returns to Home, second Esc cancels & restores margin=1.
    app.terminal.send("\x1b")
    await waitFor(() => app.live().includes("Theme & Appearance"), "back at settings home")
    app.terminal.send("\x1b")
    await waitFor(() => !app.live().includes("Layout & Display"), "settings closed")
    expect(savedSettings).toEqual([])
    expect(savedThemes).toEqual([])

    // 2. Direct jump `/settings theme`, switch appearance to light + margin to 4, and save!
    app.terminal.send("/settings theme\r")
    await waitFor(() => app.live().includes("Color depth"), "opened Theme & Appearance directly")
    expect(topBorderIndent()).toBe(1)
    clickText("[ light ]")
    clickText("[ Layout ]")
    await waitFor(() => app.live().includes("Side margin"), "switched to Layout")
    clickText("[ 4 ]")
    await waitFor(() => topBorderIndent() === 4, "live margin=4 preview")
    clickText("[ Save changes ]")
    await waitFor(() => savedThemes.length === 1 && savedSettings.length === 1, "both theme and layout saved")
    expect(savedThemes[0]).toEqual({ name: "amira", variant: "light", shimmer: undefined })
    expect(savedSettings[0]).toEqual({ margin: 4 })
  } finally {
    app.terminal.send("\x03\x03")
    await app.exited
  }
})
