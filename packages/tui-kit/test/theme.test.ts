import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { stripAnsi } from "../src/ansi.ts"
import { blend, detectColorDepth, nearest256, quantize } from "../src/colors.ts"
import { renderMarkdown } from "../src/components/markdown-stream.ts"
import { boostSurface, consoleHost, palettes, surfacePalette } from "../src/palette.ts"
import {
  createTheme,
  defaultTheme,
  markdownTheme,
  monoTheme,
  stripColors,
  surfaceTheme,
  terminalTheme,
} from "../src/style.ts"

const options = { env: {}, colorDepth: "truecolor", platform: "other" } as const

test("quantizer passes truecolor through, finds perceptually nearest fixed xterm colours, or falls back", () => {
  expect(quantize("#78dbe2", "truecolor", 36)).toBe("38;2;120;219;226")
  expect(quantize("#202020", "truecolor", 40, true)).toBe("48;2;32;32;32")
  expect(nearest256("#000000")).toBe(16)
  expect(nearest256("#ffffff")).toBe(231)
  expect(nearest256("#808080")).toBe(244)
  expect(nearest256("#5f87af")).toBe(67)
  expect(quantize("#5f87af", "256", 34)).toBe("38;5;67")
  expect(quantize("#808080", "256", 40, true)).toBe("48;5;244")
  expect(quantize("#78dbe2", "16", 36)).toBe("36")
  expect(quantize("#202020", "16", 40, true)).toBe("40")
  expect(nearest256(blend("#78dbe2", "#6fb3e8", 0.5))).toBeGreaterThanOrEqual(16)
})

test("depth detection respects known env hints and existing modern capability replies", () => {
  for (const env of [
    { COLORTERM: "truecolor" },
    { COLORTERM: "24bit" },
    { COLORTERM: "TRUECOLOR" },
    { WT_SESSION: "1" },
    { TERM: "xterm-direct" },
    ...["iTerm.app", "WezTerm", "vscode", "ghostty"].map((TERM_PROGRAM) => ({ TERM_PROGRAM })),
  ])
    expect(detectColorDepth(env)).toBe("truecolor")
  expect(detectColorDepth({ COLORTERM: "truecolor", TERM: "xterm-256color" })).toBe("truecolor")
  expect(detectColorDepth({ TERM: "xterm-256color" })).toBe("256")
  expect(detectColorDepth({ TERM: "screen-256color" }, { kittyKeyboard: true })).toBe("256")
  expect(detectColorDepth({}, { kittyKeyboard: true })).toBe("truecolor")
  expect(detectColorDepth({}, { win32InputMode: true })).toBe("truecolor")
  expect(detectColorDepth({}, { graphics: { answered: true, kitty: true, sixel: false } })).toBe("truecolor")
  expect(detectColorDepth({}, { synchronizedOutput: true })).toBe("16")
  expect(detectColorDepth({ TERM: "xterm" })).toBe("16")
  expect(detectColorDepth({})).toBe("16")
})

test("auto chooses the detected background, unknown is dark, settings override depth and appearance", () => {
  const dark = createTheme(options)
  const light = createTheme({ ...options, capabilities: { background: "light" } })
  expect(dark.accent("x")).toBe("\x1b[38;2;120;219;226mx\x1b[39m")
  expect(light.accent("x")).toBe("\x1b[38;2;21;124;132mx\x1b[39m")
  expect(createTheme({ ...options, theme: "dark", capabilities: { background: "light" } }).accent("x")).toBe(
    dark.accent("x"),
  )
  expect(createTheme({ ...options, theme: "light", capabilities: { background: "dark" } }).accent("x")).toBe(
    light.accent("x"),
  )
  expect(createTheme({ ...options, colorDepth: "256", env: { COLORTERM: "truecolor" } }).accent("x")).toBe(
    `\x1b[38;5;${nearest256("#78dbe2")}mx\x1b[39m`,
  )
  for (const theme of [
    createTheme({ ...options, colorDepth: "16" }),
    createTheme({ ...options, theme: "terminal" }),
  ]) {
    for (const token of [
      "accent",
      "muted",
      "error",
      "success",
      "warning",
      "border",
      "heading",
      "code",
      "keyword",
      "string",
      "number",
    ]) {
      expect(theme[token]!("x")).toBe(terminalTheme[token]!("x"))
    }
    for (const style of Object.values(theme)) expect(style("x")).not.toMatch(/\[(?:38|48);2;/)
  }
  expect(dark.text("x")).toBe("x")
  expect(light.text("x")).toBe("x")
  expect(defaultTheme.accent("x")).toBe(terminalTheme.accent("x"))
})

test("legacy depth-16 and terminal surfaces retain their exact original indexed backgrounds", () => {
  const tokens = ["userBg", "diffAddedBg", "diffRemovedBg", "diffAddedWordBg", "diffRemovedWordBg"] as const
  for (const [background, indices] of [
    ["dark", [236, 22, 52, 28, 88]],
    ["light", [254, 194, 224, 157, 217]],
    [undefined, [242, 65, 131, 71, 167]],
  ] as const) {
    for (const theme of [
      surfaceTheme(background, "16"),
      createTheme({ ...options, colorDepth: "16", capabilities: { background } }),
      createTheme({ ...options, theme: "terminal", capabilities: { background }, platform: "win32" }),
    ]) {
      for (const [i, token] of tokens.entries()) {
        expect(theme[token]!("x")).toBe(`\x1b[48;5;${indices[i]}mx\x1b[49m`)
      }
      expect(theme.codeBg).toBeUndefined()
      expect(theme.surfaceMuted!("x")).toBe(background ? "\x1b[90mx\x1b[39m" : "x")
    }
  }
})

test("256-colour diff surfaces preserve green/red hues and stronger word highlights", () => {
  for (const [appearance, indices] of [
    ["dark", [22, 52, 28, 88]],
    ["light", [194, 224, 151, 217]],
  ] as const) {
    const theme = createTheme({ ...options, theme: appearance, colorDepth: "256" })
    for (const [i, token] of [
      "diffAddedBg",
      "diffRemovedBg",
      "diffAddedWordBg",
      "diffRemovedWordBg",
    ].entries()) {
      expect(theme[token]!("x")).toBe(`\x1b[48;5;${indices[i]}mx\x1b[49m`)
    }
    expect(theme.userBg!("x")).toBe(`\x1b[48;5;${nearest256(palettes[appearance].userBg)}mx\x1b[49m`)
  }
})

test("public default themes retain ANSI foregrounds without unconditional truecolor", () => {
  for (const theme of [defaultTheme, markdownTheme]) {
    for (const style of Object.values(theme)) expect(style("x")).not.toMatch(/\[(?:38|48);2;/)
  }
  expect(defaultTheme.accent("x")).toBe("\x1b[36mx\x1b[39m")
  expect(markdownTheme.code("x")).toBe("\x1b[35mx\x1b[39m")
  expect(defaultTheme.chipInfo!("x")).toBe(
    "\x1b[38;5;24m▐\x1b[39m\x1b[48;5;24m\x1b[38;5;231mx\x1b[39m\x1b[49m\x1b[38;5;24m▌\x1b[39m",
  )
})

test("code backgrounds colour existing fenced rows without changing layout", () => {
  const source = "```ts\nconst x = 1\n```"
  const theme = createTheme(options)
  const painted = renderMarkdown(source, 40, theme)
  expect(painted.map(stripAnsi)).toEqual(renderMarkdown(source, 40, defaultTheme).map(stripAnsi))
  expect(painted.every((row) => row.startsWith("\x1b[48;2;25;25;25m") && row.endsWith("\x1b[49m"))).toBe(true)
})

test("NO_COLOR and dumb terminals always select mono, even with explicit colour settings", () => {
  for (const env of [{ NO_COLOR: "1" }, { TERM: "dumb" }]) {
    expect(createTheme({ ...options, theme: "light", env })).toBe(monoTheme)
  }
  expect(createTheme({ ...options, color: false })).toBe(monoTheme)
  expect(createTheme({ ...options, env: { NO_COLOR: "" } })).not.toBe(monoTheme)
  for (const style of Object.values(monoTheme)) expect(stripColors(style("x"))).toBe(style("x"))
})

test("all semantic palette foregrounds and shimmer stops are exact RGB styles", () => {
  for (const appearance of ["dark", "light"] as const) {
    const theme = createTheme({ ...options, theme: appearance })
    const p = palettes[appearance]
    for (const token of [
      "accent",
      "path",
      "command",
      "fg2",
      "muted",
      "dim",
      "border",
      "borderFocused",
      "thinking",
      "success",
      "error",
      "warning",
      "keyword",
      "string",
      "number",
    ] as const) {
      expect(theme[token]!("x")).toBe(`\x1b[${quantize(p[token], "truecolor", 90)}mx\x1b[39m`)
    }
    expect(theme.heading1!("x")).toBe(
      `\x1b[1m\x1b[${quantize(p.heading1, "truecolor", 36)}mx\x1b[39m\x1b[22m`,
    )
    expect(theme.heading!("x")).toBe(`\x1b[1m\x1b[${quantize(p.heading, "truecolor", 36)}mx\x1b[39m\x1b[22m`)
    expect(theme.shimmer0!("x")).toBe(theme.shimmer("x"))
    expect(theme.shimmer15!("x")).toBe(theme.shimmerEnd!("x"))
    expect(theme.string!("x")).not.toBe(theme.number!("x"))
    expect(theme.code!("x")).toBe(theme.command("x"))
  }
})

test("Windows boost separates surfaces only on Windows console hosts, without touching the base", () => {
  expect(consoleHost({ WT_SESSION: "1" })).toBe("windows-terminal")
  expect(consoleHost({})).toBe("conhost")
  expect(consoleHost({ WT_SESSION: "1", TERM_PROGRAM: "vscode" })).toBe("other")
  expect(consoleHost({ WT_SESSION: "1", WSL_DISTRO_NAME: "Ubuntu" })).toBe("other")
  expect(boostSurface("#202020", "#121212", "#e4e4e4", "linux", "conhost")).toBe("#202020")
  expect(boostSurface("#202020", "#121212", "#e4e4e4", "win32", "other")).toBe("#202020")
  expect(boostSurface("#202020", "#121212", "#e4e4e4", "win32", "conhost")).toBe("#272727")
  expect(boostSurface("#e8e6e1", "#f6f5f2", "#222222", "win32", "windows-terminal")).toBe("#e1dfda")
  const normal = surfacePalette(palettes.dark, undefined, "other", "other")
  const boosted = surfacePalette(palettes.dark, undefined, "win32", "windows-terminal")
  for (const name of Object.keys(normal) as (keyof typeof normal)[])
    expect(boosted[name]).not.toBe(normal[name])
})

test("unusual backgrounds derive visible surfaces from OSC RGB rather than assuming near-black", () => {
  const detected = { r: 64 / 255, g: 80 / 255, b: 96 / 255 }
  const surfaces = surfacePalette(palettes.dark, detected, "other", "other")
  expect(surfaces.userBg).toBe("#505f6d")
  expect(surfaces.codeBg).toBe("#4a5968")
  expect(surfaces.diffAddedBg).not.toBe(palettes.dark.diffAddedBg)
  expect(surfaces.diffAddedWordBg).not.toBe(surfaces.diffAddedBg)
  const theme = createTheme({ ...options, capabilities: { background: "dark", backgroundRgb: detected } })
  expect(theme.userBg!("x")).toBe("\x1b[48;2;80;95;109mx\x1b[49m")
  expect(surfacePalette(palettes.dark, { r: 0, g: 0, b: 0 }, "other", "other").userBg).toBe("#202020")
})

test("UI source modules never bypass semantic tokens with colour functions or raw colour SGR", () => {
  const root = resolve(import.meta.dir, "../../..")
  const offenders: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "test", "tests"].includes(entry.name)) continue
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (
        entry.name.endsWith(".ts") &&
        !file.endsWith("tui-kit\\src\\style.ts") &&
        !file.endsWith("tui-kit/src/style.ts")
      ) {
        const source = readFileSync(file, "utf8")
        const rawCall = /\b(?:cyan|gray|fg256|bg256|rgb|red|green|yellow|blue|magenta|white|black)\s*\(/
        const rawSgr = /\\x1b\[(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;[^m"'`]*)?m/
        if (rawCall.test(source) || rawSgr.test(source)) offenders.push(file)
      }
    }
  }
  for (const dir of ["packages/tui/src", "packages/tui-kit/src", "extensions"]) visit(resolve(root, dir))
  expect(offenders).toEqual([])
})
