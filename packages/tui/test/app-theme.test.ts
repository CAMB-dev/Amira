// A/B/D deliberate UI oracles: shared two-cell grid, fill-only code, rounded dialogs, › and ·.
import { expect, test } from "bun:test"
import type { ShimmerEffect, TuiSettings } from "@amira/api"
import { ThemeRegistry } from "@amira/core"
import type { ThemeVariant } from "@amira/tui-kit"
import { glyphs } from "../src/glyphs.ts"
import { setup, waitFor } from "./app-harness.ts"

const selectedAppearance = (variant: ThemeVariant) =>
  new RegExp(`\x1b\\[1m(?:\x1b\\[[\\d;]+m)*${variant}\x1b\\[`)

test("interactive startup applies palette and depth settings, with mono taking precedence", async () => {
  const cases = [
    { settings: { theme: "dark", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[38;2;120;219;226m›" },
    { settings: { theme: "light", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[38;2;21;124;132m›" },
    { settings: { theme: "terminal", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[36m›" },
    { settings: { theme: "light", colorDepth: "truecolor" }, env: { NO_COLOR: "1" }, prompt: "\x1b[1m›" },
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
    expect(s.terminal.output).toContain("\x1b[38;2;1;2;3m›")
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
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;7;8;9m>"), "reloaded editor prompt")
    expect(s.terminal.output).toContain("\x1b[38;2;10;11;12m")
    expect(s.terminal.output).not.toContain("\x1b[38;2;4;5;6m")
    expect(s.live()).toContain("* first item")
    expect(glyphs.toolFailed).toBe("✗")
    s.terminal.clearWrites()
    remove()
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;1;2;3m›"), "restored editor prompt")
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
  const saved: { name: string; variant: string }[] = []
  const s = await setup([], {
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", theme: "dark", colorDepth: "truecolor" },
    saveTheme: (name, variant) => {
      saved.push({ name, variant })
    },
  })
  const dark = "\x1b[38;2;120;219;226m"
  const light = "\x1b[38;2;21;124;132m"
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    expect(s.terminal.output).toMatch(selectedAppearance("dark"))
    s.terminal.clearWrites()
    s.terminal.send("\x1b[C")
    await waitFor(() => s.terminal.output.includes(light), "light preview")
    expect(saved).toEqual([])
    s.terminal.clearWrites()
    s.terminal.send("\x1b")
    await waitFor(() => s.terminal.output.includes(`${dark}›`), "restored dark prompt")
    expect(saved).toEqual([])
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("arrows preview"), "reopened theme picker")
    s.terminal.send("\x1b[C\r")
    await waitFor(() => saved.length === 1, "applied theme")
    expect(saved).toEqual([{ name: "amira", variant: "light" }])
    expect(s.terminal.output).toContain(`${light}›`)
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("theme picker lists built-ins first, custom themes next and terminal last", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", description: "User palette" }, "user")
  for (const name of ["ascii", "mono", "lavender", "burnt", "amber", "amira"])
    themes.register({ name }, "built-in")
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    rows: 60,
    settings: { mode: "fullscreen", theme: "auto" },
  })
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    const rows = s.live().split("\n")
    const names = rows.flatMap((row) => {
      const name = row.match(
        /^│[› ](?:\d+ )?(amira|amber|burnt|lavender|mono|ascii|custom|terminal)(?=\s|$)/,
      )?.[1]
      return name ? [name] : []
    })
    expect(names).toEqual(["amira", "amber", "burnt", "lavender", "mono", "ascii", "custom", "terminal"])
    expect(rows.find((row) => /\bamira\b/.test(row))).toContain("current")
    expect(s.terminal.output).toMatch(selectedAppearance("auto"))
    expect(s.live()).toContain("user · User palette")
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("theme and variant preview survive reload and Esc restores both from the current registry", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", light: { accent: "#010203" } }, "user")
  themes.register({ name: "amber", dark: { accent: "#040506" } }, "built-in")
  const saved: string[] = []
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", theme: "custom", themeVariant: "light", colorDepth: "truecolor" },
    saveTheme: (name) => {
      saved.push(name)
    },
  })
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    s.terminal.send("amber")
    await waitFor(() => s.live().includes("filter"), "filtered theme")
    s.terminal.clearWrites()
    s.terminal.send("\x1b[D")
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;4;5;6m›"), "amber dark preview")
    themes.register({ name: "custom", light: { accent: "#070809" } }, "user")
    s.terminal.clearWrites()
    s.terminal.send("\x1b")
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;7;8;9m›"), "restored custom light after reload")
    expect(saved).toEqual([])
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("arrows preview"), "reopened picker")
    expect(s.terminal.output).toMatch(selectedAppearance("light"))
    s.terminal.send("\t")
    await waitFor(
      () =>
        new RegExp(`${String.fromCharCode(27)}\\[1m(?:${String.fromCharCode(27)}\\[[\\d;]*m)*Shimmer:`).test(
          s.terminal.output,
        ),
      "Tab focuses shimmer",
    )
    expect(s.terminal.output).toMatch(selectedAppearance("light"))
    s.terminal.clearWrites()
    s.terminal.send("\t\x1b[C")
    await waitFor(
      () => selectedAppearance("auto").test(s.terminal.output),
      "appearance arrows after returning focus",
    )
    s.terminal.send("\x1b")
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("legacy light opens as current Amira light and direct names keep the appearance", async () => {
  const saved: { name: string; variant: string }[] = []
  const s = await setup([], {
    commands: [],
    tuiCommands: true,
    settings: { theme: "light", themeVariant: "dark", colorDepth: "truecolor" },
    saveTheme: (name, variant) => {
      saved.push({ name, variant })
    },
  })
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    expect(s.terminal.output).toMatch(selectedAppearance("light"))
    expect(
      s
        .live()
        .split("\n")
        .find((row) => /\bamira\b/.test(row)),
    ).toContain("current")
    s.terminal.send("\r")
    await waitFor(() => saved.length === 1, "normalized legacy theme save")
    s.terminal.send("/theme amber\r")
    await waitFor(() => saved.length === 2, "named theme save")
    expect(saved).toEqual([
      { name: "amira", variant: "light" },
      { name: "amber", variant: "light" },
    ])
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
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
    expect(s.terminal.output).toContain("\x1b[38;2;21;124;132m›")
    expect(s.terminal.output).not.toContain("\x1b[38;2;1;2;3m")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("registry changes replace the active overlay's theme in fullscreen", async () => {
  for (const mode of ["fullscreen"] as const) {
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
      // D: reload redraws the title bold in normal text, without an accent-colored ? prefix.
      await waitFor(() => s.terminal.output.includes("  \x1b[1mKeys\x1b[22m"), "rethemed overlay")
      expect(s.terminal.output).not.toContain("\x1b[38;2;1;2;3m")
      s.terminal.send("\x1b")
      await waitFor(() => s.terminal.output.includes("\x1b[38;2;7;8;9m›"), "rethemed input after overlay")
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
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;120;219;226m›"), "current-registry fallback")
    // Redrawing the live prompt must not resurrect disposed theme colors.
    expect(s.terminal.output).not.toContain("\x1b[38;2;1;2;3m›")
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
    expect(s.terminal.output).toContain("\x1b[38;2;21;124;132m›")
    s.terminal.clearWrites()
    s.terminal.send("/theme dark\r")
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;120;219;226m›"), "explicit dark palette")
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
        treePipe: "|",
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
    expect(s.live()).toContain("  shift+tab mode  ·  ctrl+o detail  ·  ? keys")
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

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: short theme picker keeps the actual appearance key in its footer`, async () => {
    const saved: { name: string; variant: string }[] = []
    const s = await setup([], {
      cols: 60,
      rows: 6,
      commands: [],
      tuiCommands: true,
      settings: { mode },
      saveTheme: (name, variant) => {
        saved.push({ name, variant })
      },
    })
    try {
      s.terminal.send("/theme\r")
      await waitFor(() => s.live().includes("tab appearance"), "visible appearance footer")
      expect(s.live()).not.toContain("Appearance:")
      expect(
        s
          .live()
          .split("\n")
          .find((line) => line.includes("tab appearance")),
      ).toContain("enter choose")
      s.terminal.send("\x1b[C\r")
      await waitFor(() => saved.length === 1, "theme and appearance saved")
      expect(saved).toEqual([{ name: "amira", variant: "dark" }])
    } finally {
      s.terminal.send("\x1b")
      await Bun.sleep(40)
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })
}

test("idle theme picker starts a live activity preview and cancellation stops it", async () => {
  const s = await setup([], {
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", colorDepth: "truecolor" },
  })
  try {
    expect(s.live()).not.toContain("Responding…")
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("Responding…"), "idle shimmer preview")
    expect(s.agent.status).toBe("idle")
    s.terminal.clearWrites()
    await waitFor(() => s.terminal.writes.length > 1, "animated idle preview frames")
    expect(s.terminal.output).toContain("\x1b[38;2;")
    s.terminal.send("\x1b")
    await waitFor(() => !s.live().includes("Responding…"), "idle preview stopped")
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("picker cycles every shimmer preset, applies it, and soft explicitly deletes the override", async () => {
  const saved: [string, ThemeVariant, ShimmerEffect?][] = []
  const s = await setup([], {
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", shimmer: "off" },
    saveTheme: (name, variant, ...shimmer) => {
      saved.push([name, variant, ...shimmer])
    },
  })
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    s.terminal.send("\t")
    await waitFor(
      () =>
        new RegExp(`${String.fromCharCode(27)}\\[1m(?:${String.fromCharCode(27)}\\[[\\d;]*m)*Shimmer:`).test(
          s.terminal.output,
        ),
      "shimmer focus",
    )
    for (const preset of ["soft", "sharp", "wide", "bounce", "pulse", "wave", "reveal"]) {
      s.terminal.send("\x1b[C")
      await waitFor(() => s.live().includes(`Shimmer: ${preset}`), `${preset} preview`)
      expect(saved).toEqual([])
    }
    s.terminal.send("\t\r")
    await waitFor(() => saved.length === 1, "shimmer writeback")
    expect(saved).toEqual([["amira", "auto", "reveal"]])
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("arrows preview"), "reopened picker")
    s.terminal.send("\t\x1b[C\x1b[C\x1b[C")
    await waitFor(() => s.live().includes("Shimmer: soft"), "soft reset")
    s.terminal.send("\t\r")
    await waitFor(() => saved.length === 2, "soft writeback")
    expect(saved[1]).toEqual(["amira", "auto", undefined])
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("picker customizes all six knobs, inherits the theme, and color pairs follow appearance", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", shimmerEffect: { style: "wave", width: 11, period: 2400 } }, "user")
  const colors = { dark: ["#110000", "#220000"], light: ["#001100", "#002200"] } as const
  themes.register(
    {
      name: "amber",
      dark: { shimmer: colors.dark[0], shimmerEnd: colors.dark[1] },
      light: { shimmer: colors.light[0], shimmerEnd: colors.light[1] },
    },
    "built-in",
  )
  const saved: [string, ThemeVariant, ShimmerEffect?][] = []
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    cols: 110,
    rows: 40,
    settings: { mode: "fullscreen", theme: "custom", themeVariant: "dark", colorDepth: "truecolor" },
    saveTheme: (name, variant, ...shimmer) => {
      saved.push([name, variant, ...shimmer])
    },
  })
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    s.terminal.send("\t\r")
    await waitFor(() => s.live().includes("Customize shimmer"), "customize panel")
    expect(s.live()).toContain("style: wave")
    expect(s.live()).toContain("width: 11")
    s.terminal.send("\x1b[C\x1b[B\x1b[C\x1b[B\x1b[C\x1b[B\x1b[C\x1b[B\x1b[C\x1b[B\x1b[C\x1b[C")
    await waitFor(() => s.live().includes("colors: amber (#110000 → #220000)"), "amber dark shimmer pair")
    expect(s.live()).toContain("style: reveal")
    expect(s.live()).toContain("width: 12")
    expect(s.live()).toContain("period: 2600 ms")
    expect(s.live()).toContain("edge: linear")
    expect(s.live()).toContain("direction: rtl")
    expect(saved).toEqual([])
    s.terminal.clearWrites()
    s.terminal.send("\r\t\x1b[C")
    await waitFor(() => selectedAppearance("light").test(s.terminal.output), "appearance after customize")
    s.terminal.send("\t\r")
    await waitFor(() => s.live().includes("colors: amber (#001100 → #002200)"), "amber light shimmer pair")
    s.terminal.send("\r\r")
    await waitFor(() => saved.length === 1, "custom override writeback")
    expect(saved).toEqual([
      [
        "custom",
        "light",
        {
          style: "reveal",
          width: 12,
          period: 2600,
          edge: "linear",
          direction: "rtl",
          colors,
        },
      ],
    ])
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("Esc in customize and abort after reload both restore the prior shimmer override", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", shimmerEffect: "pulse" }, "user")
  const saved: ShimmerEffect[] = []
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", theme: "custom", shimmer: { width: 8 }, colorDepth: "truecolor" },
    saveTheme: (_name, _variant, shimmer) => {
      if (shimmer) saved.push(shimmer)
    },
  })
  try {
    s.terminal.send("/theme\r")
    await s.shows("arrows preview")
    s.terminal.send("\t\r\x1b[B\x1b[C")
    await waitFor(() => s.live().includes("width: 9"), "changed width")
    themes.register({ name: "custom", shimmerEffect: "wave" }, "user")
    s.terminal.send("\x1b")
    await waitFor(() => !s.live().includes("Customize shimmer"), "customize Esc cancels picker")
    expect(saved).toEqual([])
    const controller = new AbortController()
    const picking = s.commands!.run("/theme", { frontend: "tui", signal: controller.signal })
    await waitFor(() => s.live().includes("arrows preview"), "abortable picker")
    s.terminal.send("\t\r")
    await waitFor(() => s.live().includes("Customize shimmer"), "restored customize panel")
    expect(s.live()).toContain("width: 8")
    expect(s.live()).toContain("style: wave")
    s.terminal.send("\x1b[B\x1b[C")
    await waitFor(() => s.live().includes("width: 9"), "abortable width change")
    themes.register({ name: "custom", shimmerEffect: "reveal" }, "user")
    controller.abort()
    await picking
    await waitFor(() => !s.live().includes("Responding…"), "abort stopped preview")
    expect(saved).toEqual([])
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("arrows preview"), "picker after abort")
    s.terminal.send("\t\r")
    await waitFor(() => s.live().includes("Customize shimmer"), "customize after abort")
    expect(s.live()).toContain("width: 8")
    expect(s.live()).toContain("style: reveal")
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("soft overrides a pulse theme and theme removes the override", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", shimmerEffect: "pulse" }, "user")
  const saved: (ShimmerEffect | undefined)[] = []
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", theme: "custom" },
    saveTheme: (_name, _variant, shimmer) => {
      saved.push(shimmer)
    },
  })
  try {
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("Shimmer: theme (pulse)"), "inherited pulse entry")
    s.terminal.send("\t\x1b[C\x1b[C")
    await waitFor(() => s.live().includes("Shimmer: soft"), "explicit soft selection")
    s.terminal.send("\t\r")
    await waitFor(() => saved.length === 1, "soft saved on pulse theme")
    expect(saved).toEqual(["soft"])
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("Shimmer: soft"), "picker retains explicit soft")
    s.terminal.send("\t\x1b[D\x1b[D")
    await waitFor(() => s.live().includes("Shimmer: theme (pulse)"), "theme selection")
    s.terminal.send("\t\r")
    await waitFor(() => saved.length === 2, "theme clears user override")
    expect(saved).toEqual(["soft", undefined])
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("up/down focuses the theme list and leaves both controls unhighlighted", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "amira", shimmerEffect: "pulse" }, "built-in")
  themes.register({ name: "amber", shimmerEffect: "wave" }, "built-in")
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    settings: { mode: "fullscreen", theme: "amira" },
  })
  try {
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("Shimmer: theme (pulse)"), "Amira pulse")
    expect(s.live()).toContain("←/→ change")
    s.terminal.send("\t\x1b[B")
    await waitFor(() => s.live().includes("Shimmer: theme (wave)"), "down previews Amber")
    expect(s.live()).not.toContain("│›Shimmer:")
    expect(s.live()).not.toContain("│›Appearance:")
    // The arrows only change a focused control, so the list's footer leaves them out.
    expect(s.live()).not.toContain("←/→ change")
    s.terminal.send("\x1b[A")
    await waitFor(() => s.live().includes("Shimmer: theme (pulse)"), "up returns to Amira")
    expect(s.live()).not.toContain("│›Shimmer:")
    expect(s.live()).not.toContain("│›Appearance:")
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})

test("reloaded theme settings replace palette, appearance and shimmer in the running TUI", async () => {
  let apply: ((settings: TuiSettings | undefined) => void) | undefined
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", light: { accent: "#010203" }, shimmerEffect: "pulse" }, "user")
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    settings: {
      mode: "fullscreen",
      theme: "amira",
      themeVariant: "dark",
      shimmer: "off",
      colorDepth: "truecolor",
    },
    subscribeThemeSettings: (listener) => {
      apply = listener
      return () => {
        apply = undefined
      }
    },
  })
  try {
    apply!({ theme: "custom", themeVariant: "light", shimmer: "wave" })
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;1;2;3m›"), "reloaded light palette")
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("Shimmer: wave"), "reloaded shimmer selection")
    expect(s.terminal.output).toMatch(selectedAppearance("light"))
    apply!(undefined)
    await waitFor(() => !s.live().includes("arrows preview"), "reload replaces the open preview")
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("Shimmer: theme (soft)"), "removed settings restore defaults")
    expect(s.terminal.output).toMatch(selectedAppearance("auto"))
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
  expect(apply).toBeUndefined()
})

test("runtime shimmer tokens use the resolved override pair for the preview's current appearance", async () => {
  const themes = new ThemeRegistry()
  themes.register({ name: "custom", shimmerEffect: { style: "wave", edge: "hard" } }, "user")
  const s = await setup([], {
    themes,
    commands: [],
    tuiCommands: true,
    settings: {
      mode: "fullscreen",
      theme: "custom",
      themeVariant: "dark",
      colorDepth: "truecolor",
      shimmer: { colors: { dark: ["#110000", "#110000"], light: ["#001100", "#001100"] } },
    },
  })
  try {
    s.terminal.send("/theme\r")
    await waitFor(() => s.live().includes("Responding…"), "configured idle preview")
    expect(s.terminal.output).toContain("\x1b[38;2;17;0;0m")
    s.terminal.clearWrites()
    s.terminal.send("\x1b[C")
    await waitFor(() => s.terminal.output.includes("\x1b[38;2;0;17;0m"), "resolved light shimmer colors")
  } finally {
    s.terminal.send("\x1b")
    await Bun.sleep(40)
    s.terminal.send("\x03\x03")
    await s.exited
  }
})
