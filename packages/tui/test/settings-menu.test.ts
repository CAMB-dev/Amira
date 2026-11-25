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
import { SettingsView } from "../src/settings-menu.ts"
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

function findCell(rows: string[], text: string, offset = 2, rowMatch?: string): { x: number; y: number } {
  const y = rows.findIndex((row) => {
    const plain = stripAnsi(row)
    return plain.includes(text) && (!rowMatch || plain.includes(rowMatch))
  })
  if (y === -1) throw new Error(`Target not found: ${text}\n${rows.map(stripAnsi).join("\n")}`)
  const plain = stripAnsi(rows[y]!)
  return { x: visibleWidth(plain.slice(0, plain.indexOf(text))) + offset, y }
}

function click(view: SettingsView, rows: string[], text: string, offset = 2, rowMatch?: string): void {
  const pt = findCell(rows, text, offset, rowMatch)
  view.handleInput(mouse(pt.x, pt.y, "press"))
  view.handleInput(mouse(pt.x, pt.y, "release"))
}

describe("SettingsView (fullscreen top-tab studio + translucent floating preview)", () => {
  test("renders fullscreen top tabs with inline Layout & Theme previews and saves edits across tabs", () => {
    const previews: { margin: number; theme: string; tab: string; floating?: string }[] = []
    let savedPatch: Partial<TuiSettings> | undefined
    let cancelled = 0
    const view = new SettingsView({
      initial: { margin: 1, marginRows: 0 },
      themeNames: ["amira", "amber", "burnt", "lavender", "mono", "ascii", "terminal"],
      viewport: () => ({ columns: 120, rows: 36 }),
      now: () => 500,
      onPreview: (draft, mode) =>
        previews.push({ margin: draft.margin, theme: draft.theme, tab: mode.tab, floating: mode.floating }),
      onSave: (patch) => {
        savedPatch = patch
      },
      onCancel: () => {
        cancelled++
      },
    })

    // Fullscreen starts on Layout tab with top tab bar and inline Layout Preview mini-map.
    let rows = view.render(118, ctx)
    expect(rows).toHaveLength(36)
    expect(view.activeTab).toBe("layout")
    expect(view.overlayCardSpec(120, ctx)).toBeUndefined()
    let text = rows.map(stripAnsi).join("\n")
    expect(text).toContain("[ Layout ]")
    expect(text).toContain("[ Theme ]")
    expect(text).toContain("[ Behavior ]")
    expect(text).toContain("[ Alerts ]")
    expect(text).toContain("Layout Preview")
    expect(text).toContain("Live preview on chat")
    expect(text).toContain("Conversation 118×36")

    // Adjust margin directly on Layout tab.
    click(view, rows, "[ 4 ]")
    expect(view.draft.margin).toBe(4)
    expect(previews.at(-1)).toMatchObject({ margin: 4, tab: "layout", floating: undefined })

    // Switch to Theme tab via top tab bar; shows inline live Theme & Shimmer preview + animation cadence.
    rows = view.render(118, ctx)
    click(view, rows, "[ Theme ]")
    expect(view.activeTab).toBe("appearance")
    expect(view.refreshIntervalMs).toBeGreaterThan(0)
    rows = view.render(118, ctx)
    text = rows.map(stripAnsi).join("\n")
    expect(text).toContain("Theme Preview")
    expect(text).toContain("Thinking · live theme & shimmer preview")
    click(view, rows, "[ lavender ]")
    rows = view.render(118, ctx)
    click(view, rows, "[ light ]")
    rows = view.render(118, ctx)
    click(view, rows, "[ 256 ]")

    // Switch to Behavior & Alerts tabs via top tab bar.
    rows = view.render(118, ctx)
    click(view, rows, "[ Behavior ]")
    expect(view.activeTab).toBe("behavior")
    expect(view.refreshIntervalMs).toBeUndefined()
    rows = view.render(118, ctx)
    click(view, rows, "[ queue ]")
    click(view, rows, "[ 24h ]")

    rows = view.render(118, ctx)
    click(view, rows, "[ Alerts ]")
    expect(view.activeTab).toBe("alerts")
    rows = view.render(118, ctx)
    click(view, rows, "[ Off ]")

    // Save changes persists all modified tabs.
    rows = view.render(118, ctx)
    click(view, rows, "[ Save changes ]")
    expect(cancelled).toBe(0)
    expect(savedPatch).toEqual({
      margin: 4,
      theme: "lavender",
      themeVariant: "light",
      colorDepth: "256",
      submitWhileWorking: "queue",
      clock: "24h",
      bell: false,
    })
  })

  test("floating Layout preview enables live translucent card, reverts on Cancel, and keeps on OK", () => {
    let savedPatch: Partial<TuiSettings> | undefined
    const view = new SettingsView({
      initial: { margin: 2, marginRows: 0 },
      viewport: () => ({ columns: 120, rows: 36 }),
      onPreview: () => {},
      onSave: (patch) => {
        savedPatch = patch
      },
      onCancel: () => {},
    })

    // Enter translucent floating Layout preview by clicking button.
    let rows = view.render(118, ctx)
    click(view, rows, "Live preview on chat")
    expect(view.floatingPreview).toBe("layout")
    expect(view.overlayCardSpec(120, ctx)).toEqual({ width: 72, live: true })

    // Floating card leaves empty rows above/below for the live dimmed conversation backdrop.
    rows = view.render(120, ctx)
    expect(rows[0]).toBe("")
    expect(rows.at(-1)).toBe("")
    const cardText = rows.map(stripAnsi).join("\n")
    expect(cardText).toContain("Layout Preview")
    expect(cardText).toContain("[ OK ]")
    expect(cardText).toContain("[ Cancel ]")

    // Adjust margin to 8, then click [ Cancel ] -> reverts to checkpoint (2) and returns to fullscreen.
    click(view, rows, "[ 8 ]")
    expect(view.draft.margin).toBe(8)
    rows = view.render(120, ctx)
    click(view, rows, "[ Cancel ]")
    expect(view.floatingPreview).toBeUndefined()
    expect(view.draft.margin).toBe(2)

    // Re-enter via 'p' hotkey, adjust margin to 6 & rows to 1, click [ OK ] -> kept in fullscreen draft!
    view.handleInput(key("p"))
    expect(view.floatingPreview).toBe("layout")
    rows = view.render(120, ctx)
    click(view, rows, "[ 6 ]")
    rows = view.render(120, ctx)
    click(view, rows, "[ 1 ]", 2, "Top/bottom rows")
    rows = view.render(120, ctx)
    click(view, rows, "[ OK ]")
    expect(view.floatingPreview).toBeUndefined()
    expect(view.draft.margin).toBe(6)
    expect(view.draft.marginRows).toBe(1)

    rows = view.render(118, ctx)
    click(view, rows, "[ Save changes ]")
    expect(savedPatch).toEqual({ margin: 6, marginRows: 1 })
  })
})

test("/settings fullscreen tabs + translucent centered Layout preview updates real dimmed chat live", async () => {
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
  const chatHeaderIndent = () => {
    const headerRow = app.screen.lines[0]!
    // Header text starts 2 cells in from the content edge (CONTENT_INSET), so margin = firstNonSpace - 2.
    return headerRow.search(/\S/) - 2
  }
  try {
    // 1. Open fullscreen /settings: fills full screen with top tabs & inline preview.
    app.terminal.send("/settings\r")
    await waitFor(
      () => app.live().includes("[ Layout ]") && app.live().includes("Layout Preview"),
      "fullscreen settings opened",
    )

    // 2. Click Live preview on chat -> centered floating card appears over the real dimmed conversation!
    clickText("Live preview on chat")
    await waitFor(
      () =>
        app.live().includes("[ OK ]") &&
        app.live().includes("[ Cancel ]") &&
        app.screen.lines[0]!.trim().length > 0,
      "translucent floating layout preview opened over real chat",
    )
    expect(chatHeaderIndent()).toBe(1)

    // 3. Click [ 6 ] in the centered floating card -> real background conversation header shifts to col 6 LIVE!
    clickText("[ 6 ]")
    await waitFor(() => chatHeaderIndent() === 6, "live background conversation shifted to margin=6")

    // 4. Click [ Cancel ] in the floating card -> reverts margin to 1 (not dirty -> "[ Save ]") and returns to fullscreen Settings!
    clickText("[ Cancel ]")
    await waitFor(
      () => app.live().includes("[ Layout ]") && app.live().includes("[ Save ]"),
      "returned to fullscreen settings after Cancel",
    )

    // 5. Re-open preview via 'p', click [ 4 ], click [ OK ] -> keeps margin=4!
    app.terminal.send("p")
    await waitFor(() => app.live().includes("[ OK ]"), "re-opened floating layout preview")
    expect(chatHeaderIndent()).toBe(1)
    clickText("[ 4 ]")
    await waitFor(() => chatHeaderIndent() === 4, "live background shifted to margin=4")
    clickText("[ OK ]")
    await waitFor(() => app.live().includes("[ Save changes ]"), "returned to fullscreen settings after OK")

    // 6. Switch to [ Theme ] tab, pick [ light ], and click [ Save changes ]!
    clickText("[ Theme ]")
    await waitFor(() => app.live().includes("Theme Preview"), "switched to Theme tab")
    clickText("[ light ]")
    clickText("[ Save changes ]")
    await waitFor(() => savedThemes.length === 1 && savedSettings.length === 1, "saved theme and layout")
    expect(savedThemes[0]).toEqual({ name: "amira", variant: "light", shimmer: undefined })
    expect(savedSettings[0]).toEqual({ margin: 4 })
  } finally {
    app.terminal.send("\x03\x03\x03")
    await app.exited
  }
})
