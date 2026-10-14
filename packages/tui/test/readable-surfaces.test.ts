import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import type { ViewDefinition } from "@amira/api"
import {
  createTheme,
  defaultGlyphs,
  key,
  renderMarkdown,
  stripAnsi,
  type ThemeDefinition,
} from "@amira/tui-kit"
import { DockedView } from "../src/app/dock.ts"
import { userBlock } from "../src/blocks.ts"
import { ExtensionViewer } from "../src/extension-view.ts"
import { localClock, rememberMessageTime, timestampRow, userLines } from "../src/format.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import { stickyPromptLine } from "../src/pane/sticky-prompt.ts"

const themesDir = new URL("../../cli/themes/", import.meta.url)
const names = readdirSync(themesDir).filter((name) => name.endsWith(".json"))
const at = new Date(2026, 9, 10, 20, 9).getTime()
const comment = "// scroll-anchor: a stable search target"
const hosts = [
  { platform: "other", env: {} },
  { platform: "win32", env: {} },
  { platform: "win32", env: { WT_SESSION: "readability-test" } },
] as const

/** Resolve the last explicit foreground/background before the rendered text, including xterm quantization. */
function colorBefore(row: string, text: string, kind: "38" | "48"): number[] {
  const start = row.indexOf(text)
  expect(start).toBeGreaterThanOrEqual(0)
  const codes = [
    ...row.slice(0, start).matchAll(new RegExp(`\\x1b\\[${kind};(2;\\d+;\\d+;\\d+|5;\\d+)m`, "g")),
  ]
  const code = codes.at(-1)![1]!
  if (code.startsWith("2;")) return code.split(";").slice(1).map(Number)
  const index = Number(code.slice(2))
  if (index >= 232) return Array(3).fill(8 + (index - 232) * 10)
  const cube = index - 16
  const steps = [0, 95, 135, 175, 215, 255]
  return [steps[Math.floor(cube / 36)]!, steps[Math.floor(cube / 6) % 6]!, steps[cube % 6]!]
}

function luminance(rgb: number[]): number {
  const linear = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function contrast(row: string, text: string): number {
  const values = [luminance(colorBefore(row, text, "38")), luminance(colorBefore(row, text, "48"))].sort(
    (a, b) => b - a,
  )
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

for (const name of names) {
  const definition: ThemeDefinition = JSON.parse(readFileSync(new URL(name, themesDir), "utf8"))
  for (const appearance of ["dark", "light"] as const) {
    for (const colorDepth of ["truecolor", "256"] as const) {
      for (const host of hosts) {
        const label = `${name} ${appearance} ${colorDepth} ${host.platform} ${"WT_SESSION" in host.env ? "windows-terminal" : "default"}`
        const theme = createTheme({ ...host, definition, themeVariant: appearance, colorDepth })
        test(`readable surface comment: ${label}`, () => {
          const row = renderMarkdown(`\`\`\`ts\n${comment}\n\`\`\``, 60, theme).find((row) =>
            row.includes(comment),
          )!
          expect(contrast(row, comment)).toBeGreaterThanOrEqual(4.5)
          expect(row).toContain(theme.fg2(comment))
          for (const token of ["rule", "tableBorder", "quoteBar"])
            expect(theme[token]!("line")).toBe(theme.dim("line"))
          const label = renderMarkdown("```ts\nx\n```", 60, theme)[0]!
          expect(contrast(label, "ts")).toBeGreaterThanOrEqual(4.5)
          expect(label).toContain(theme.surfaceMuted!("ts"))
        })
        test(`readable dock labels and every host hint branch: ${label}`, () => {
          const ctx = { theme, color: true, rows: 30 }
          const keys = defaultKeybindings()
          const check = (rows: string[], text: string) => {
            const row = rows.find((row) => row.includes(text))!
            expect(contrast(row, text)).toBeGreaterThanOrEqual(4.5)
            expect(colorBefore(row, text, "38")).toEqual(colorBefore(theme.surfaceMuted!(text), text, "38"))
          }
          const definitions: ViewDefinition[] = [
            {
              kind: "plain",
              title: () => "Dock",
              titleAside: () => "aside",
              header: () => [{ kind: "muted", text: "header" }],
              render: () => Array.from({ length: 40 }, () => ({ kind: "muted", text: "secondary" })),
              keys: [{ key: "p", label: "print", run: () => {} }],
            },
            {
              kind: "widgets",
              title: () => "Widgets",
              ui: () => ({
                type: "text",
                id: "body",
                lines: [{ kind: "muted", text: "widget hint" }],
              }),
            },
            { kind: "minimal", title: () => "Minimal", render: () => [], hostKeys: "minimal" },
            {
              kind: "code",
              title: () => "Dock code",
              render: (_data, options) => options.renderReply?.("```ts\n// dock comment\n```") ?? [],
            },
          ]
          for (const definition of definitions) {
            const viewer = new ExtensionViewer(definition, {}, { placement: "dock", keys })
            const dock = new DockedView(viewer, keys, 10)
            try {
              let rows = dock.render(140, ctx, 10)
              if (definition.kind === "plain") {
                for (const text of ["aside", "header", "secondary"]) check(rows, text)
                expect(rows.find((row) => row.includes("─"))!).toContain(theme.dim("─".repeat(140)))
              }
              if (definition.kind === "widgets") check(rows, "widget hint")
              if (definition.kind === "code") {
                check(rows, "ts")
                check(rows, "// dock comment")
              }
              for (const text of ["scroll dock", "follow", "close dock"]) check(rows, text)
              dock.handleInput(key("pageup"))
              rows = dock.render(140, ctx, 10)
              if (definition.kind === "plain") check(rows, "of 40")
              viewer.focused = true
              rows = dock.render(140, ctx, 10)
              check(rows, "close")
              if (definition.kind === "plain") {
                check(rows, "print")
                check(rows, "scroll")
              }
              if (definition.kind === "widgets") {
                check(rows, "navigate")
                check(rows, "open/send")
              }
            } finally {
              viewer.dispose()
            }
          }
        })
        test(`readable surface user timestamp: ${label}`, () => {
          const clock = localClock(at)
          const rows = userLines(theme, { role: "user", content: [{ type: "text", text: "Hello" }] }, 60, at)
          const row = rows.find((row) => row.includes(clock))!
          expect(contrast(row, clock)).toBeGreaterThanOrEqual(4.5)
          expect(row).toContain(theme.surfaceMuted!(clock))
          const message = { role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }
          rememberMessageTime(message, at)
          const compact = stickyPromptLine(userBlock(message), {
            theme,
            width: 60,
            now: at,
            spinner: "*",
            detail: "summary",
            presenters: undefined,
            hyperlinks: false,
            nodes: new Map(),
          })
          expect(contrast(compact, clock)).toBeGreaterThanOrEqual(4.5)
          expect(compact).toContain(theme.surfaceMuted!(clock))
          // Unpainted assistant/thinking clocks retain the ordinary muted role.
          expect(timestampRow("Reply", theme, 60, at)).toContain(theme.muted(clock))
          const { userBg: _, ...unbanded } = theme
          expect(userLines(unbanded, { role: "user", content: [] }, 60, at)[0]).toContain(theme.muted(clock))
        })
      }
    }
  }
}

test("ASCII clipped code-language chrome is readable without rewriting fixture labels", () => {
  const definition: ThemeDefinition = JSON.parse(readFileSync(new URL("ascii.json", themesDir), "utf8"))
  const theme = createTheme({
    definition,
    themeVariant: "dark",
    colorDepth: "truecolor",
    env: {},
    platform: "other",
  })
  const glyphs = { ...defaultGlyphs, ...definition.glyphs }
  const row = renderMarkdown("\x60\x60\x60a-very-long-language\nx\n\x60\x60\x60", 8, theme, { glyphs })[0]!
  expect(stripAnsi(row)).toBe("a-very-.")
  expect(stripAnsi(row)).not.toMatch(/[^\p{ASCII}]/u)
  expect(contrast(row, "a-very-.")).toBeGreaterThanOrEqual(4.5)
  const fixture = renderMarkdown("\x60\x60\x60语言\nx\n\x60\x60\x60", 8, theme, { glyphs })[0]!
  expect(stripAnsi(fixture)).toContain("语言")
})
