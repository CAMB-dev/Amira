import { describe, expect, test } from "bun:test"
import type { TuiSettings } from "@amira/api"
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

describe("SettingsMenuDialog", () => {
  test("clicks category tabs, margin preset pills, steppers, toggles, reset and save", () => {
    const previews: number[] = []
    let savedPatch: Partial<TuiSettings> | undefined
    let cancelled = 0
    const dialog = new SettingsMenuDialog({
      initial: { margin: 1, marginRows: 0 },
      viewport: () => ({ columns: 120, rows: 36 }),
      onPreview: (draft) => previews.push(draft.margin),
      onSave: (patch) => {
        savedPatch = patch
      },
      onCancel: () => {
        cancelled++
      },
    })

    let rows = dialog.render(100, ctx)
    expect(rows.map(stripAnsi).join("\n")).toContain("118×36 (margin 1, rows 0)")
    expect(rows.map(stripAnsi).join("\n")).toContain("[ Layout ]")
    expect(rows.map(stripAnsi).join("\n")).toContain("[ Interface ]")
    expect(rows.map(stripAnsi).join("\n")).toContain("[ Alerts ]")

    // Click side margin preset [ 4 ]
    click(dialog, rows, "[ 4 ]")
    expect(dialog.draft.margin).toBe(4)
    expect(previews.at(-1)).toBe(4)
    rows = dialog.render(100, ctx)
    expect(rows.map(stripAnsi).join("\n")).toContain("112×36 (margin 4, rows 0)")
    expect(rows.map(stripAnsi).join("\n")).toContain("unsaved")

    // Click [ + ] stepper to reach custom margin 5 (dynamically displayed as a highlighted pill)
    click(dialog, rows, "[ + ]")
    expect(dialog.draft.margin).toBe(5)
    rows = dialog.render(100, ctx)
    expect(rows.map(stripAnsi).join("\n")).toContain("[ 5 ]")

    // Switch to Interface tab by mouse click
    click(dialog, rows, "[ Interface ]")
    expect(dialog.activeTab).toBe("interface")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ 24h ]")
    click(dialog, rows, "[ queue ]")
    expect(dialog.draft.clock).toBe("24h")
    expect(dialog.draft.submitWhileWorking).toBe("queue")

    // Switch to Alerts tab and click [ Off ] on Terminal bell
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ Alerts ]")
    expect(dialog.activeTab).toBe("alerts")
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ Off ]")
    expect(dialog.draft.bell).toBe(false)

    // Save changes by clicking [ Save changes ]
    rows = dialog.render(100, ctx)
    click(dialog, rows, "[ Save changes ]")
    expect(cancelled).toBe(0)
    expect(savedPatch).toEqual({
      margin: 5,
      clock: "24h",
      submitWhileWorking: "queue",
      bell: false,
    })
  })

  test("cancel and Esc discard changes without calling save", () => {
    let saved = 0
    let cancelled = 0
    const dialog = new SettingsMenuDialog({
      initial: { margin: 2 },
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
    dialog.handleInput(key("escape"))
    expect(saved).toBe(0)
    expect(cancelled).toBe(1)
  })
})

test("/settings previews live screen margins on click, restores on Esc, and persists on Save", async () => {
  const saved: Partial<TuiSettings>[] = []
  const app = await setup([], {
    commands: [],
    tuiCommands: true,
    cols: 110,
    rows: 34,
    settings: { margin: 1, marginRows: 0 },
    saveTuiSettings: (patch) => {
      saved.push(patch)
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
    app.terminal.send("/settings\r")
    await waitFor(() => app.live().includes("Side margin"), "settings menu opened")
    expect(topBorderIndent()).toBe(1)

    // Clicking [ 6 ] live-previews margin=6 on the actual screen immediately!
    clickText("[ 6 ]")
    await waitFor(() => topBorderIndent() === 6, "live margin=6 preview")
    expect(saved).toEqual([])

    // Esc restores margin=1 without saving.
    app.terminal.send("\x1b")
    await waitFor(() => !app.live().includes("Side margin"), "settings menu closed")
    expect(saved).toEqual([])

    // Reopen, click [ 4 ], then click [ Save changes ] to persist!
    app.terminal.send("/settings\r")
    await waitFor(() => app.live().includes("Side margin"), "settings menu reopened")
    expect(topBorderIndent()).toBe(1)
    clickText("[ 4 ]")
    await waitFor(() => topBorderIndent() === 4, "live margin=4 preview")
    clickText("[ Save changes ]")
    await waitFor(() => saved.length === 1, "settings saved")
    expect(saved[0]).toEqual({ margin: 4 })
  } finally {
    app.terminal.send("\x03\x03")
    await app.exited
  }
})
