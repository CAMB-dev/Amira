import { expect, test } from "bun:test"
import { type ExtensionStatusMetadata, extensionStatusBadge } from "@amira/api"
import { defaultTheme, key, type RenderContext, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { Dialog } from "../src/dialog.ts"
import { styledExtensionLabel, styledExtensionStatusBadge } from "../src/extension-status.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"

const statuses = ["experimental", "wip", "deprecated"] as const

test.each([...statuses])("%s badges use ASCII and semantic host tones in either glyph mode", (status) => {
  const metadata: ExtensionStatusMetadata = { status }
  const badge = extensionStatusBadge(metadata)
  const styled = styledExtensionStatusBadge(metadata, defaultTheme)
  expect(badge).toMatch(/^[\x20-\x7e]+$/)
  expect(styled).toBe(status === "experimental" ? defaultTheme.muted(badge) : defaultTheme.warning(badge))
  expect(styledExtensionStatusBadge({}, defaultTheme)).toBe("")
  for (const ascii of [false, true]) {
    try {
      setGlyphs(ascii ? { pointer: ">", choice: ">", more: "...", separator: "|" } : {})
      const label = `package ${badge} 1.0.0`
      const answers: unknown[] = []
      const dialog = new Dialog(
        {
          kind: "select",
          requestId: "extension-status",
          title: "Extensions",
          options: [label],
          optionExtensionStatuses: [metadata],
        },
        (answer) => answers.push(answer),
      )
      const ctx: RenderContext = { theme: defaultTheme, color: true, rows: 20 }
      const rows = dialog.render(70, ctx)
      expect(stripAnsi(rows.join("\n"))).toContain(label)
      expect(rows.join("\n")).toContain(styled)
      expect(rows.every((row) => visibleWidth(row) <= 70)).toBe(true)
      dialog.handleInput(key("enter"))
      expect(answers).toEqual([label])
    } finally {
      setGlyphs()
    }
  }
})

test("badge-like extension names are not recolored without metadata", () => {
  const label = "package [wip]"
  expect(styledExtensionLabel(label, undefined, defaultTheme, false)).toBe(label)
  expect(styledExtensionLabel(label, {}, defaultTheme, true)).toBe(defaultTheme.accent(label))
  expect(glyphs.pointer).toBeTruthy()
})
