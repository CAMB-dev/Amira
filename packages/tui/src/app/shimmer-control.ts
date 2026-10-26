// Local theme-picker controls; edits remain sparse overrides of the selected theme.
import type {
  ShimmerColors,
  ShimmerEffect,
  ShimmerOptions,
  ShimmerPreset,
  ShimmerStyle,
  ThemeDefinition,
} from "@amira/api"
import { normalizeShimmer, resolveShimmer, SHIMMER_PRESETS } from "@amira/core"
import { bold, type InputEvent, type RenderContext, type Theme, underline } from "@amira/tui-kit"
import { Dialog } from "../dialog.ts"
import { dialogFrame } from "../dialog-frame.ts"
import { glyphs } from "../glyphs.ts"
import { type Keybindings, keyLabel } from "../keybindings.ts"

const PRESETS = Object.keys(SHIMMER_PRESETS) as ShimmerPreset[]
const CHOICES = ["theme", ...PRESETS] as const
const STYLES: ShimmerStyle[] = ["off", "sweep", "bounce", "pulse", "wave", "reveal"]
const KNOBS = ["style", "width", "period", "edge", "direction", "colors"] as const
const DEFAULT_COLORS: Exclude<ShimmerColors, readonly unknown[]> = {
  dark: ["#bcdcf6", "#c6f1f4"],
  light: ["#123f6a", "#0b4f55"],
}

function cycle<T>(values: readonly T[], value: T, step: number): T {
  return values[(values.indexOf(value) + step + values.length) % values.length]!
}

/** A named pair keeps both appearances, so changing appearance never freezes the old colors. */
export function shimmerColorChoices(
  definitions: readonly ThemeDefinition[],
): { name: string; colors: ShimmerColors }[] {
  return definitions.map((definition) => ({
    name: definition.name,
    colors: {
      dark: [
        definition.dark?.shimmer ?? DEFAULT_COLORS.dark[0],
        definition.dark?.shimmerEnd ?? DEFAULT_COLORS.dark[1],
      ],
      light: [
        definition.light?.shimmer ?? DEFAULT_COLORS.light[0],
        definition.light?.shimmerEnd ?? DEFAULT_COLORS.light[1],
      ],
    },
  }))
}

export class ShimmerControl {
  /** The picker opens on the current theme; Tab moves into the appearance and shimmer controls. */
  focus: "list" | "appearance" | "shimmer" = "list"
  customizing = false
  private knob = 0
  private colorChoice: string | undefined
  private returnedFromCustomize = false

  constructor(
    public override: ShimmerEffect | undefined,
    private readonly deps: {
      keys: Keybindings
      definition: () => ThemeDefinition | undefined
      variant: () => "dark" | "light"
      colors: () => { name: string; colors: ShimmerColors }[]
      changed: (override: ShimmerEffect | undefined) => void
    },
  ) {}

  private get resolved(): ReturnType<typeof resolveShimmer> {
    return resolveShimmer(this.deps.definition()?.shimmerEffect, this.override)
  }

  get preset(): ShimmerPreset | "theme" | "custom" {
    const normalized = normalizeShimmer(this.override)
    if (!normalized || !Object.keys(normalized).length) return "theme"
    if (normalized.preset && KNOBS.every((key) => key === "colors" || normalized[key] === undefined))
      return normalized.preset === "sweep" ? "soft" : normalized.preset
    const resolved = this.resolved
    return (
      PRESETS.find((preset) =>
        KNOBS.every((key) => key === "colors" || SHIMMER_PRESETS[preset][key] === resolved[key]),
      ) ?? "custom"
    )
  }

  get opensCustomize(): boolean {
    return this.focus === "shimmer" && !this.returnedFromCustomize
  }

  header(appearance: "auto" | "dark" | "light", theme: Theme): string {
    const accent = (text: string) => bold(theme.accent(text))
    const separator = theme.muted(` ${glyphs.separator} `)
    const appearanceFocused = this.focus === "appearance"
    const variants = ["auto", "dark", "light"].map((variant) =>
      variant === appearance
        ? appearanceFocused
          ? accent(variant)
          : theme.muted(underline(bold(variant)))
        : theme.muted(variant),
    )
    const appearanceLabel = appearanceFocused ? accent("Appearance: ") : theme.muted("Appearance: ")
    const effect = resolveShimmer(this.deps.definition()?.shimmerEffect)
    const inherited =
      PRESETS.find((preset) =>
        KNOBS.every((key) => key === "colors" || SHIMMER_PRESETS[preset][key] === effect[key]),
      ) ?? effect.style
    const label = this.preset === "theme" ? `theme (${inherited})` : this.preset
    const shimmer = `Shimmer: ${label}`
    // The controls share the list's cursor column, so focusing them never shifts their text.
    const marker = this.focus === "list" ? "  " : `${accent(glyphs.choice)} `
    return `${marker}${appearanceLabel}${variants.join(separator)}${separator}${
      this.focus === "shimmer" ? accent(shimmer) : theme.muted(shimmer)
    }`
  }

  /** Esc belongs to Dialog and cancels the entire preview, including the customize panel. */
  handleInput(event: InputEvent): boolean {
    const { keys } = this.deps
    if (keys.is(event, "dialog.choose")) {
      if (this.customizing) {
        this.customizing = false
        this.focus = "shimmer"
        this.returnedFromCustomize = true
        return true
      }
      if (this.opensCustomize) {
        this.customizing = true
        return true
      }
      return false
    }
    const up = keys.is(event, "dialog.up")
    const down = keys.is(event, "dialog.down")
    const horizontal =
      event.type === "key" && !event.ctrl && !event.alt && ["left", "right"].includes(event.name)
    if (this.customizing) {
      if (up || down) this.knob = (this.knob + (up ? -1 : 1) + KNOBS.length) % KNOBS.length
      else if (horizontal) this.changeKnob(event.name === "left" ? -1 : 1)
      // Text and list shortcuts must not change the hidden theme selection.
      return true
    }
    if (event.type !== "key") return false
    if (!event.ctrl && !event.alt && event.name === "tab") {
      this.focus = this.focus === "appearance" ? "shimmer" : "appearance"
      this.returnedFromCustomize = false
      return true
    }
    if (up || down) {
      this.focus = "list"
      this.returnedFromCustomize = false
      return false
    }
    const step = event.name === "left" ? -1 : 1
    if (this.focus !== "shimmer" || !horizontal) return false
    const at = this.preset
    const preset = cycle(CHOICES, at === "custom" ? "theme" : at, step)
    this.colorChoice = undefined
    this.returnedFromCustomize = false
    this.update(preset === "theme" ? undefined : preset)
    return true
  }

  private update(override: ShimmerEffect | undefined): void {
    this.override = override
    this.deps.changed(override)
  }

  private colorName(colors: ShimmerColors | undefined): string {
    if (!colors) return "theme"
    const same = (candidate: ShimmerColors) => JSON.stringify(candidate) === JSON.stringify(colors)
    const choices = this.deps.colors()
    const selected = choices.find((choice) => choice.name === this.colorChoice && same(choice.colors))
    return selected?.name ?? choices.find((choice) => same(choice.colors))?.name ?? "custom"
  }

  private changeKnob(step: number): void {
    const key = KNOBS[this.knob]!
    const resolved = this.resolved
    const next: ShimmerOptions = { ...normalizeShimmer(this.override) }
    switch (key) {
      case "style":
        next.style = cycle(STYLES, resolved.style, step)
        break
      case "width":
        next.width = Math.min(20, Math.max(1, resolved.width + step))
        break
      case "period":
        next.period = Math.min(5000, Math.max(400, resolved.period + step * 200))
        break
      case "edge":
        next.edge = cycle(["soft", "linear", "hard"] as const, resolved.edge, step)
        break
      case "direction":
        next.direction = cycle(["ltr", "rtl"] as const, resolved.direction, step)
        break
      case "colors": {
        const choices = this.deps.colors()
        const names = ["theme", ...choices.map((choice) => choice.name)]
        const name = cycle(names, this.colorName(next.colors), step)
        const colors = choices.find((choice) => choice.name === name)?.colors
        this.colorChoice = name
        if (colors) next.colors = colors
        else delete next.colors
        break
      }
    }
    this.update(Object.keys(next).length ? next : undefined)
  }

  render(width: number, ctx: RenderContext, maxRows: number): string[] {
    const { theme } = ctx
    const resolved = this.resolved
    const normalized = normalizeShimmer(this.override)
    const colors = resolved.colors
    const pair = colors && ("dark" in colors ? colors[this.deps.variant()] : colors)
    const values = [
      resolved.style,
      resolved.width,
      `${resolved.period} ms`,
      resolved.edge,
      resolved.direction,
      `${this.colorName(normalized?.colors)}${pair ? ` (${pair.join(" → ")})` : ""}`,
    ]
    const rows = KNOBS.map((key, index) => {
      const text = `${key}: ${values[index]}`
      return index === this.knob ? theme.accent(`${glyphs.choice} ${text}`) : `  ${theme.muted(text)}`
    })
    // Reserve title, interior hint and bottom edge before choosing the visible knob window,
    // then the blank rows that set the knobs apart from title and hint, as other dialogs have.
    const spaced = maxRows - 3 - KNOBS.length >= 2
    const room = Math.max(1, maxRows - 3 - (spaced ? 2 : 0))
    const start = Math.max(0, Math.min(this.knob, rows.length - room))
    const choose = this.deps.keys.label("dialog.choose")?.toLowerCase()
    const cancel = this.deps.keys.label("dialog.cancel")?.toLowerCase()
    const hint = [
      `${this.deps.keys.pairLabel("dialog.up", "dialog.down")?.toLowerCase() ?? "up/down"} knob`,
      `${keyLabel({ name: "left" })}/${keyLabel({ name: "right" })} change`,
      choose && `${choose} back`,
      cancel && `${cancel} restore`,
    ]
      .filter(Boolean)
      .join(` ${glyphs.separator} `)
    return dialogFrame(
      bold(theme.text("Customize shimmer")),
      [
        ...(spaced ? [""] : []),
        ...rows.slice(start, start + room),
        ...(spaced ? [""] : []),
        theme.muted(hint),
      ],
      width,
      ctx,
      theme.accent,
      maxRows,
    )
  }
}

/** The ordinary theme list stays intact behind a compact, keyboard-only knob panel. */
export class ThemePickerDialog extends Dialog {
  shimmer!: ShimmerControl

  override render(width: number, ctx: RenderContext): string[] {
    return this.shimmer.customizing ? this.shimmer.render(width, ctx, this.maxRows) : super.render(width, ctx)
  }
}
