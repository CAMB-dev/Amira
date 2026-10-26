// A/B/D deliberate UI oracles: shared two-cell grid, fill-only code, rounded dialogs, › and ·.
import { expect, test } from "bun:test"
import { bold, createTheme, stripAnsi, underline, visibleWidth } from "@amira/tui-kit"
import { ShimmerControl, ThemePickerDialog } from "../src/app/shimmer-control.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { defaultKeybindings } from "../src/keybindings.ts"

function picker() {
  const keys = defaultKeybindings()
  const shimmer = new ShimmerControl(undefined, {
    keys,
    definition: () => undefined,
    variant: () => "dark",
    colors: () => [],
    changed: () => {},
  })
  const dialog = new ThemePickerDialog(
    { kind: "select", requestId: "test", title: "Theme", options: ["amira", "amber"] },
    () => {},
    keys,
    {
      header: (theme) => shimmer.header("auto", theme),
      handleInput: (event) => shimmer.handleInput(event),
      listFocused: () => shimmer.focus === "list",
    },
  )
  dialog.shimmer = shimmer
  return { dialog, shimmer }
}

const key = (name: string) => ({ type: "key" as const, name, ctrl: false, alt: false, shift: false })

test("picker controls highlight the focused label and value in bold accent, not a focus tag", () => {
  const { dialog, shimmer } = picker()
  const theme = createTheme({ colorDepth: "truecolor", env: {} })
  const row = () =>
    dialog.render(80, { theme, color: true, rows: 24 }).find((line) => line.includes("Appearance:"))!
  // The controls row keeps the list's cursor column inside the padded frame, focused or not.
  const framed = (text: string, selected = false) =>
    `│ ${selected ? "›" : " "} ${text}${" ".repeat(74 - visibleWidth(text))} │`
  const cursors = () =>
    dialog
      .render(80, { theme, color: true, rows: 24 })
      .map(stripAnsi)
      .filter((line) => line.startsWith("│ ›"))
  // It opens on the list: one cursor, on the current theme, and the controls unfocused.
  expect(shimmer.focus).toBe("list")
  expect(cursors()).toEqual([expect.stringContaining("› 1  amira")])
  expect(stripAnsi(row())).toBe(framed("Appearance: auto · dark · light · Shimmer: theme (soft)"))
  dialog.handleInput(key("tab"))
  // In the controls, the list keeps its place but draws no cursor.
  expect(cursors()).toEqual([expect.stringContaining("› Appearance:")])
  expect(stripAnsi(row())).toBe(framed("Appearance: auto · dark · light · Shimmer: theme (soft)", true))
  expect(row()).toContain(bold(theme.accent("›")))
  expect(row()).toContain(bold(theme.accent("Appearance: ")))
  expect(row()).toContain(bold(theme.accent("auto")))
  expect(row()).toContain(theme.muted("Shimmer: theme (soft)"))
  dialog.handleInput(key("tab"))
  expect(stripAnsi(row())).toBe(framed("Appearance: auto · dark · light · Shimmer: theme (soft)", true))
  expect(row()).toContain(bold(theme.accent("Shimmer: theme (soft)")))
  expect(row()).toContain(theme.muted(underline(bold("auto"))))
  dialog.handleInput(key("down"))
  expect(shimmer.focus).toBe("list")
  expect(stripAnsi(row())).toBe(framed("Appearance: auto · dark · light · Shimmer: theme (soft)"))
  expect(row()).toContain(theme.muted("Appearance: "))
  expect(row()).toContain(theme.muted("Shimmer: theme (soft)"))
  expect(row()).not.toContain(bold(theme.accent("auto")))
  expect(row()).toContain(theme.muted(underline(bold("auto"))))
  dialog.handleInput(key("tab"))
  expect(shimmer.focus).toBe("appearance")
})

test("picker selection and focus survive NO_COLOR, custom focus glyphs and narrow truncation", () => {
  const before = { ...glyphs }
  try {
    for (const choice of ["›", ">", "→"]) {
      setGlyphs({ choice })
      const { dialog, shimmer } = picker()
      const theme = createTheme({ env: { NO_COLOR: "1" } })
      const ctx = { theme, color: false, rows: 24 }
      for (const focus of ["appearance", "shimmer", "list"] as const) {
        shimmer.focus = focus
        const row = dialog.render(80, ctx).find((line) => line.includes("Appearance:"))!
        expect(row).toContain(bold("auto"))
        expect(stripAnsi(row)).not.toContain("[")
        expect(stripAnsi(row)).not.toContain("]")
        expect(stripAnsi(row).includes(choice)).toBe(focus !== "list")
        expect(stripAnsi(row)).toContain("auto · dark · light")
        for (const width of [8, 20, 40, 60, 80]) {
          expect(dialog.render(width, ctx).every((line) => visibleWidth(line) <= width)).toBe(true)
        }
      }
    }
  } finally {
    setGlyphs(before)
  }
})
