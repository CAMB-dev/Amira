import { expect, test } from "bun:test"
import type { ShimmerEffect, ThemeDefinition } from "@amira/api"
import { resolveShimmer } from "@amira/core"
import { type InputEvent, stripAnsi, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { ShimmerControl, shimmerColorChoices } from "../src/app/shimmer-control.ts"
import { defaultKeybindings } from "../src/keybindings.ts"

const key = (name: string): Extract<InputEvent, { type: "key" }> => ({
  type: "key",
  name,
  ctrl: false,
  alt: false,
  shift: false,
})

function control(override?: ShimmerEffect, definition?: ThemeDefinition) {
  const changes: (ShimmerEffect | undefined)[] = []
  const shimmer = new ShimmerControl(override, {
    keys: defaultKeybindings(),
    definition: () => definition,
    variant: () => "light",
    colors: () =>
      shimmerColorChoices([
        {
          name: "amber",
          dark: { shimmer: "#110000", shimmerEnd: "#220000" },
          light: { shimmer: "#001100", shimmerEnd: "#002200" },
        },
      ]),
    changed: (value) => changes.push(value),
  })
  return { shimmer, changes }
}

test("Tab switches focus without changing appearance or shimmer; preset arrows wrap", () => {
  const { shimmer, changes } = control()
  expect(shimmer.focus).toBe("appearance")
  expect(shimmer.handleInput(key("right"))).toBe(false)
  shimmer.handleInput(key("tab"))
  expect(shimmer.focus).toBe("shimmer")
  expect(changes).toEqual([])
  expect(shimmer.preset).toBe("theme")
  for (const preset of [
    "off",
    "soft",
    "sharp",
    "wide",
    "bounce",
    "pulse",
    "wave",
    "reveal",
    "theme",
  ] as const) {
    shimmer.handleInput(key("right"))
    expect(shimmer.preset).toBe(preset)
  }
  expect(shimmer.override).toBeUndefined()
  const count = changes.length
  expect(shimmer.handleInput(key("up"))).toBe(false)
  expect(shimmer.handleInput(key("down"))).toBe(false)
  expect(changes).toHaveLength(count)
  expect(shimmer.focus).toBe("list")
  shimmer.handleInput(key("tab"))
  shimmer.handleInput(key("tab"))
  shimmer.handleInput(key("left"))
  expect(shimmer.override).toBe("reveal")
  shimmer.handleInput(key("right"))
  expect(shimmer.override).toBeUndefined()
})

test("theme opens without an override and soft overrides a pulse theme", () => {
  const definition: ThemeDefinition = { name: "custom", shimmerEffect: "pulse" }
  const { shimmer } = control(undefined, definition)
  expect(shimmer.preset).toBe("theme")
  expect(stripAnsi(shimmer.header("auto", plain.theme))).toContain("Shimmer: theme (pulse)")
  shimmer.handleInput(key("tab"))
  shimmer.handleInput(key("right"))
  shimmer.handleInput(key("right"))
  expect(shimmer.override).toBe("soft")
  expect(resolveShimmer(definition.shimmerEffect, shimmer.override).style).toBe("sweep")
  shimmer.handleInput(key("left"))
  shimmer.handleInput(key("left"))
  expect(shimmer.override).toBeUndefined()
  expect(resolveShimmer(definition.shimmerEffect, shimmer.override).style).toBe("pulse")
})

test("named presets fit the picker header; longer inherited labels use normal narrow truncation", () => {
  const { shimmer } = control("reveal")
  shimmer.handleInput(key("tab"))
  const header = shimmer.header("auto", plain.theme)
  expect(visibleWidth(header)).toBeLessThanOrEqual(58)
  expect(stripAnsi(header)).toContain("Shimmer: reveal")
  const inherited = control(undefined, { name: "custom", shimmerEffect: "reveal" }).shimmer
  inherited.handleInput(key("tab"))
  const inheritedHeader = inherited.header("light", plain.theme)
  expect(stripAnsi(inheritedHeader)).toBe("Appearance: auto · dark · light · ❯ Shimmer: theme (reveal)")
  const narrow = truncateToWidth(inheritedHeader, 58, "…")
  expect(visibleWidth(narrow)).toBe(58)
  expect(stripAnsi(narrow)).toBe("Appearance: auto · dark · light · ❯ Shimmer: theme (revea…")
})

test("knob edits stay sparse and inherit the theme; panel Enter returns to Shimmer then applies", () => {
  const definition: ThemeDefinition = {
    name: "custom",
    shimmerEffect: { style: "wave", width: 11, period: 2400, direction: "rtl" },
  }
  const { shimmer } = control(undefined, definition)
  shimmer.handleInput(key("tab"))
  shimmer.handleInput(key("enter"))
  expect(shimmer.customizing).toBe(true)
  expect(shimmer.render(100, plain, 10).join("\n")).toContain(
    "↑↓ knob · ←/→ change · enter back · esc restores",
  )
  shimmer.handleInput(key("down"))
  shimmer.handleInput(key("right"))
  expect(shimmer.override).toEqual({ width: 12 })
  expect(resolveShimmer(definition.shimmerEffect, shimmer.override)).toMatchObject({
    style: "wave",
    width: 12,
    period: 2400,
    direction: "rtl",
  })
  shimmer.handleInput(key("enter"))
  expect(shimmer.customizing).toBe(false)
  expect(shimmer.focus).toBe("shimmer")
  expect(shimmer.handleInput(key("enter"))).toBe(false)
})

test("customize covers all knobs and colors retain both appearances, with theme clearing colors only", () => {
  const { shimmer } = control()
  shimmer.handleInput(key("tab"))
  shimmer.handleInput(key("enter"))
  for (let knob = 0; knob < 6; knob++) {
    shimmer.handleInput(key("right"))
    if (knob < 5) shimmer.handleInput(key("down"))
  }
  expect(shimmer.override).toEqual({
    style: "bounce",
    width: 7,
    period: 2000,
    edge: "linear",
    direction: "rtl",
    colors: { dark: ["#110000", "#220000"], light: ["#001100", "#002200"] },
  })
  expect(shimmer.render(100, plain, 10).join("\n")).toContain("amber (#001100 → #002200)")
  shimmer.handleInput(key("right"))
  expect(shimmer.override).toEqual({
    style: "bounce",
    width: 7,
    period: 2000,
    edge: "linear",
    direction: "rtl",
  })
  expect(shimmer.render(100, plain, 4)).toHaveLength(4)
  expect(shimmer.render(100, plain, 4).join("\n")).toContain("colors: theme")
})

test("numeric knobs respect core bounds and panel text never reaches the theme filter", () => {
  const { shimmer } = control({ width: 20, period: 5000 })
  shimmer.handleInput(key("tab"))
  shimmer.handleInput(key("enter"))
  shimmer.handleInput(key("down"))
  shimmer.handleInput(key("right"))
  expect(shimmer.override).toEqual({ width: 20, period: 5000 })
  shimmer.handleInput(key("down"))
  shimmer.handleInput(key("right"))
  expect(shimmer.override).toEqual({ width: 20, period: 5000 })
  expect(shimmer.handleInput({ ...key("a"), text: "a" })).toBe(true)
})
