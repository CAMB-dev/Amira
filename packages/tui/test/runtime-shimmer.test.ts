import { expect, test } from "bun:test"
import type { ShimmerEffect, ThemeDefinition } from "@amira/api"
import { ThemeRegistry } from "@amira/core"
import type { ThemeVariant } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { shimmerLabel } from "../src/app/activity-row.ts"
import type { InteractiveOptions } from "../src/app/startup.ts"
import { RuntimeThemes } from "../src/app/themes.ts"

function runtime(definition: ThemeDefinition, shimmer?: ShimmerEffect, themeVariant: ThemeVariant = "dark") {
  const registry = new ThemeRegistry()
  registry.register(definition, "user")
  // RuntimeThemes only reads the theme-facing part of InteractiveOptions.
  const options = {
    themes: registry,
    settings: { theme: definition.name, colorDepth: "truecolor", themeVariant, shimmer },
  } satisfies Pick<InteractiveOptions, "themes" | "settings">
  const themes = new RuntimeThemes(
    options as unknown as InteractiveOptions,
    {},
    {
      win32InputMode: false,
      kittyKeyboard: false,
      synchronizedOutput: false,
      shiftEnter: false,
    },
  )
  return { registry, themes }
}

const definition: ThemeDefinition = {
  name: "custom",
  dark: { muted: "#000000", shimmer: "#f00000", shimmerEnd: "#0000f0" },
  light: { muted: "#000000", shimmer: "#00f000", shimmerEnd: "#0000f0" },
  shimmerEffect: { style: "pulse", period: 2000 },
}

test("runtime knob-only overrides preserve the theme's motion and palette stops", () => {
  const { themes } = runtime(definition, { width: 3 })
  try {
    const theme = themes.current.theme
    // Deliberate color fixture update: truecolor uses 32 fade steps, preserving prototype motion.
    expect(shimmerLabel("ABCDE", { ...plain, theme, color: true }, 700)).toBe(
      "\x1b[38;2;173;0;0mA\x1b[39m" +
        "\x1b[38;2;127;0;46mB\x1b[39m" +
        "\x1b[38;2;81;0;92mC\x1b[39m" +
        "\x1b[38;2;46;0;127mD\x1b[39m" +
        "\x1b[38;2;0;0;173mE\x1b[39m",
    )
  } finally {
    themes.dispose()
  }
})

test("runtime resolves custom shared or appearance-specific stops above theme effect colors", () => {
  const colors = { dark: ["#112233", "#445566"], light: ["#778899", "#aabbcc"] } as const
  for (const variant of ["dark", "light"] as const) {
    for (const userColors of [undefined, ["#010203", "#040506"] as const, colors]) {
      const { themes } = runtime(
        { ...definition, shimmerEffect: { preset: "wave", colors } },
        userColors ? { colors: userColors } : undefined,
        variant,
      )
      try {
        const theme = themes.current.theme
        const pair = userColors && !("dark" in userColors) ? userColors : colors[variant]
        const ansi = (hex: string, text: string) =>
          `\x1b[38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m${text}\x1b[39m`
        expect(theme.shimmer("A")).toBe(ansi(pair[0], "A"))
        expect(theme.shimmerEnd!("E")).toBe(ansi(pair[1], "E"))
      } finally {
        themes.dispose()
      }
    }
  }
})

test("theme reload recomputes motion and colors while retaining a user knob override", () => {
  const { themes, registry } = runtime(definition, { width: 3 })
  themes.connect(() => {})
  try {
    const previous = themes.current.theme
    registry.register(
      {
        ...definition,
        dark: { muted: "#000000", shimmer: "#00f000", shimmerEnd: "#0000f0" },
        shimmerEffect: "wave",
      },
      "user",
    )
    const theme = themes.current.theme
    expect(theme).not.toBe(previous)
    expect(shimmerLabel("ABCDE", { ...plain, theme, color: true }, 0)).toStartWith(
      "\x1b[38;2;0;203;0mA\x1b[39m",
    )
  } finally {
    themes.dispose()
  }
})
