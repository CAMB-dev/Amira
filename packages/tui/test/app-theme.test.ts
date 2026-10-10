import { expect, test } from "bun:test"
import { ThemeRegistry } from "@amira/core"
import { glyphs } from "../src/glyphs.ts"
import { setup, waitFor } from "./app-harness.ts"

test("interactive startup applies palette and depth settings, with mono taking precedence", async () => {
  const cases = [
    { settings: { theme: "dark", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[38;2;120;219;226m› " },
    { settings: { theme: "light", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[38;2;21;124;132m› " },
    { settings: { theme: "terminal", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[36m› " },
    { settings: { theme: "light", colorDepth: "truecolor" }, env: { NO_COLOR: "1" }, prompt: "\x1b[1m› " },
  ] as const
  for (const c of cases) {
    const s = await setup([], c)
    try {
      expect(s.terminal.output).toContain(c.prompt)
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  }
})

test("registry reload and removal replace full-screen styles, transcript caches and both glyph sets", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", dark: { accent: "#010203", heading1: "#040506" } }, "user")
  const s = await setup([{ text: "# A heading\n\n- first item" }], {
    themes,
    settings: { mode: "fullscreen", theme: "custom", colorDepth: "truecolor" },
  })
  try {
    expect(s.terminal.output).toContain("\x1b[38;2;1;2;3m› ")
    s.terminal.send("go\r")
    await s.shows("first item")
    await s.idle()
    s.terminal.clearWrites()
    const remove = themes.register(
      {
        name: "custom",
        dark: { accent: "#070809", heading1: "#0a0b0c" },
        glyphs: { user: ">", bullets: ["*"] },
      },
      "extension",
    )
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;7;8;9m> "), "reloaded editor prompt")
    expect(s.terminal.output).toContain("\x1b[38;2;10;11;12m")
    expect(s.terminal.output).not.toContain("\x1b[38;2;4;5;6m")
    expect(s.live()).toContain("* first item")
    expect(glyphs.toolFailed).toBe("✗")
    s.terminal.clearWrites()
    remove()
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;1;2;3m› "), "restored editor prompt")
    expect(s.live()).toContain("• first item")
    expect(glyphs.user).toBe("›")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
  const writes = s.terminal.writes.length
  themes.register({ name: "custom", dark: { accent: "#111111" } }, "extension")
  expect(s.terminal.writes).toHaveLength(writes)
})

test("/theme arrows preview immediately, Esc restores without saving, and Enter applies", async () => {
  const saved: string[] = []
  const s = await setup([], {
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", theme: "dark", colorDepth: "truecolor" },
    saveTheme: (name) => {
      saved.push(name)
    },
  })
  const dark = "\x1b[38;2;120;219;226m"
  const light = "\x1b[38;2;21;124;132m"
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    s.terminal.clearWrites()
    s.terminal.send("\x1b[B")
    await waitFor(() => s.terminal.output.includes(light), "light preview")
    expect(saved).toEqual([])
    s.terminal.clearWrites()
    s.terminal.send("\x1b")
    await waitFor(() => s.terminal.output.includes(`${dark}› `), "restored dark prompt")
    expect(saved).toEqual([])
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("arrows preview"), "reopened theme picker")
    s.terminal.send("\x1b[B\r")
    await waitFor(() => saved.length === 1, "applied theme")
    expect(saved).toEqual(["light"])
    expect(s.terminal.output).toContain(`${light}› `)
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("named themes respect forced appearance and fall back to that variant's default palette", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "night-only", dark: { accent: "#010203" } }, "user")
  const s = await setup([], {
    themes,
    settings: { theme: "night-only", themeVariant: "light", colorDepth: "truecolor" },
  })
  try {
    expect(s.terminal.output).toContain("\x1b[38;2;21;124;132m› ")
    expect(s.terminal.output).not.toContain("\x1b[38;2;1;2;3m")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("registry changes replace the active overlay's theme in inline and full-screen modes", async () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    const themes = new ThemeRegistry()
    themes.register({ name: "custom", dark: { accent: "#010203" } }, "user")
    const s = await setup([], {
      themes,
      settings: { mode, theme: "custom", colorDepth: "truecolor" },
    })
    try {
      s.terminal.send("?")
      await s.shows("Keys")
      s.terminal.clearWrites()
      themes.register({ name: "custom", dark: { accent: "#070809" } }, "extension")
      await waitFor(() => s.terminal.output.includes("\x1b[38;2;7;8;9m?"), "rethemed overlay")
      expect(s.terminal.output).not.toContain("\x1b[38;2;1;2;3m")
      s.terminal.send("\x1b")
      await waitFor(() => s.terminal.output.includes("\x1b[38;2;7;8;9m› "), "rethemed input after overlay")
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  }
})

test("picker shows provenance and Esc does not resurrect disposed extension themes", async () => {
  const themes = new ThemeRegistry()
  const remove = themes.register(
    { name: "temporary", description: "Custom preview", dark: { accent: "#010203" } },
    "extension",
  )
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    settings: { theme: "temporary", colorDepth: "truecolor" },
  })
  try {
    s.terminal.send("/theme\r")
    await s.shows("extension")
    expect(s.live()).toContain("Custom preview")
    remove()
    s.terminal.clearWrites()
    s.terminal.send("\x1b")
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;120;219;226m› "), "current-registry fallback")
    // Already committed inline scrollback keeps its colors; the live prompt must not resurrect them.
    expect(s.terminal.output).not.toContain("\x1b[38;2;1;2;3m› ")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("closing a theme picker advances a form queued behind it", async () => {
  const s = await setup([], { commands: [], tuiCommands: true })
  let form: Promise<unknown> | undefined
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    form = s.host.ui
      .api("test:queued-form")
      .form({ title: "Queued form", fields: [{ type: "text", id: "name", label: "Name" }] })
    await s.bus.flush()
    expect(s.live()).not.toContain("Queued form")
    s.terminal.send("\x1b")
    await waitFor(() => s.live().includes("Queued form"), "queued form opening")
    s.terminal.send("\x1b")
    await form
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
    await form
  }
})

test("explicit dark selection wins over a forced named-theme light variant", async () => {
  const s = await setup([], {
    commands: [],
    tuiCommands: true,
    settings: { theme: "auto", themeVariant: "light", colorDepth: "truecolor" },
  })
  try {
    expect(s.terminal.output).toContain("\x1b[38;2;21;124;132m› ")
    s.terminal.clearWrites()
    s.terminal.send("/theme dark\r")
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;120;219;226m› "), "explicit dark palette")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("ASCII glyphs replace input-frame and status corners as well as Markdown symbols", async () => {
  const themes = new ThemeRegistry()
  themes.register(
    {
      name: "plain",
      glyphs: {
        user: ">",
        rule: "-",
        codeSide: "|",
        boxTopLeft: "+",
        boxTopRight: "+",
        boxBottomLeft: "+",
        boxBottomRight: "+",
      },
    },
    "built-in",
  )
  const s = await setup([], { themes, settings: { theme: "plain" } })
  try {
    expect(s.live()).toContain("+---")
    expect(s.live()).not.toMatch(/[╭╮╰╯│─]/u)
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("validated invalid glyph overrides fall back to the TUI and Markdown defaults", async () => {
  const warnings: string[] = []
  const themes = new ThemeRegistry((message) => warnings.push(message))
  themes.register(
    {
      name: "invalid-glyphs",
      glyphs: { user: "🙂", bullets: ["wide"], toolFailed: "!" },
    },
    "user",
  )
  const s = await setup([{ text: "- first item" }], {
    themes,
    settings: { mode: "fullscreen", theme: "invalid-glyphs", colorDepth: "truecolor" },
  })
  try {
    expect(warnings.length).toBeGreaterThan(0)
    expect(glyphs.user).toBe("›")
    expect(glyphs.toolFailed).toBe("!")
    s.terminal.send("go\r")
    await s.shows("first item")
    await s.idle()
    expect(s.live()).toContain("• first item")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
  expect(glyphs.toolFailed).toBe("✗")
})
