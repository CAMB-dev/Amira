import type { ExtensionSettingField, ExtensionSettingsValues } from "@amira/api"
import {
  bold,
  closeStyles,
  colourSwatch,
  type HitRect,
  inverse,
  type LineInput,
  type RenderContext,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { glyphs, viewEllipsis } from "./glyphs.ts"

export type SettingsMouseAction =
  | {
      kind: "field"
      index: number
      key?: "left" | "right" | "space"
      value?: string | number | boolean
      column?: number
    }
  | { kind: "key"; key: "enter" | "escape" | "y" | "n" }
  | { kind: "reset" }
  | { kind: "scope"; scope: "user" | "project" }

export interface SettingsTarget {
  id: string
  rect: HitRect
  action: SettingsMouseAction
}

export interface SettingsRow {
  lines: string[]
  targets: SettingsTarget[]
}

export function renderSettingsRow(
  field: ExtensionSettingField,
  index: number,
  focused: boolean,
  values: ExtensionSettingsValues,
  inputs: ReadonlyMap<string, LineInput>,
  numberInput: LineInput | undefined,
  width: number,
  theme: Theme,
  ascii: boolean,
  color: boolean,
): SettingsRow {
  const value = values[field.key] ?? field.default
  const changed = value !== field.default ? " *" : ""
  const label = `${focused ? glyphs.pointer : " "} ${field.label}${changed}`
  const labelStyle = focused ? (s: string) => bold(theme.accent(s)) : theme.text
  const controlStyle = focused
    ? (text: string) => (color ? inverse(theme.accent(text)) : bold(theme.accent(text)))
    : theme.fg2
  const pill = (text: string, active: boolean, disabled = false) => {
    const raw = `[ ${text} ]`
    if (disabled) return theme.dim(raw)
    if (active) return focused && color ? inverse(bold(theme.accent(raw))) : bold(theme.accent(raw))
    return focused ? theme.fg2(raw) : theme.muted(raw)
  }
  const labelWidth = visibleWidth(label) + 2
  const controlRoom = Math.max(12, width - labelWidth)
  let control: string
  const pillTargets: { id: string; offset: number; size: number; action: SettingsMouseAction }[] = []
  switch (field.type) {
    case "number": {
      const display =
        focused && numberInput
          ? numberInput.render(Math.max(4, Math.min(16, width - 12)), theme, { focused: true })
          : String(value)
      const minusDisabled = field.min !== undefined && Number(value) <= field.min
      const plusDisabled = field.max !== undefined && Number(value) >= field.max
      const val = `[ ${display} ]`
      const valStyled = focused && color ? inverse(bold(theme.accent(val))) : bold(theme.accent(val))
      control = `${pill("-", false, minusDisabled)} ${valStyled} ${pill("+", false, plusDisabled)}`
      pillTargets.push(
        { id: "left", offset: 0, size: 5, action: { kind: "field", index, key: "left" } },
        {
          id: "right",
          offset: 5 + 1 + visibleWidth(val) + 1,
          size: 5,
          action: { kind: "field", index, key: "right" },
        },
      )
      break
    }
    case "choice": {
      const opts = field.options.map((o) =>
        typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value },
      )
      const allWidth = opts.reduce((s, o, idx) => s + visibleWidth(`[ ${o.label} ]`) + (idx ? 1 : 0), 0)
      if (allWidth <= controlRoom && opts.length <= 5) {
        let cursor = 0
        const rendered: string[] = []
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i]!
          const size = visibleWidth(`[ ${opt.label} ]`)
          pillTargets.push({
            id: `opt:${i}`,
            offset: cursor,
            size,
            action: { kind: "field", index, value: opt.value },
          })
          rendered.push(pill(opt.label, opt.value === value))
          cursor += size + 1
        }
        control = rendered.join(" ")
      } else {
        const option = opts.find((o) => o.value === value)
        const shown = option?.label ?? String(value)
        const valRaw = `[ ${shown} ]`
        const valStyled = focused && color ? inverse(bold(theme.accent(valRaw))) : bold(theme.accent(valRaw))
        control = `${pill(ascii ? "<" : "‹", false)} ${valStyled} ${pill(ascii ? ">" : "›", false)}`
        pillTargets.push(
          { id: "left", offset: 0, size: 5, action: { kind: "field", index, key: "left" } },
          {
            id: "right",
            offset: 5 + 1 + visibleWidth(valRaw) + 1,
            size: 5,
            action: { kind: "field", index, key: "right" },
          },
        )
      }
      break
    }
    case "toggle": {
      const on = value === true
      control = `${pill("On", on)} ${pill("Off", !on)}`
      pillTargets.push(
        { id: "on", offset: 0, size: 6, action: { kind: "field", index, value: true } },
        { id: "off", offset: 7, size: 7, action: { kind: "field", index, value: false } },
      )
      break
    }
    default: {
      const input = inputs.get(field.key)!
      const inputWidth = width - labelWidth >= 12 ? width - labelWidth - 2 : width - 4
      const text = input.render(Math.max(1, inputWidth), theme, {
        focused,
        placeholder: field.type === "text" ? field.placeholder : "#rrggbb",
      })
      control = controlStyle(`[ ${text} ]`)
      if (field.type === "colour" && /^#[\da-f]{6}$/i.test(String(value))) {
        const swatch = colourSwatch(String(value), ascii ? "##" : "██")
        control = `${swatch} ${control}`
      }
    }
  }
  const inline = visibleWidth(label) + 2 + visibleWidth(control) <= width
  const lines = inline
    ? [truncateToWidth(`${labelStyle(label)}  ${control}`, width, viewEllipsis())]
    : [
        truncateToWidth(labelStyle(label), width, viewEllipsis()),
        truncateToWidth(`  ${control}`, width, viewEllipsis()),
      ]
  const x = inline ? visibleWidth(label) + 2 : 2
  const y = inline ? 0 : 1
  const targets: SettingsTarget[] = [
    {
      id: `field:${index}`,
      rect: { x: 0, y: 0, width, height: lines.length },
      action: { kind: "field", index, ...(field.type === "toggle" ? { key: "space" } : {}) },
    },
  ]
  const controlWidth = visibleWidth(control)
  const limit = x + controlWidth <= width ? width : Math.max(0, width - visibleWidth(viewEllipsis()))
  const add = (id: string, column: number, size: number, action: SettingsMouseAction) => {
    const shown = Math.min(size, limit - column)
    if (shown > 0)
      targets.push({ id: `${id}:${index}`, rect: { x: column, y, width: shown, height: 1 }, action })
  }
  if (pillTargets.length) {
    for (const t of pillTargets) add(t.id, x + t.offset, t.size, t.action)
  } else if (field.type === "text" || field.type === "colour") {
    const swatch = field.type === "colour" && /^#[\da-f]{6}$/i.test(String(value)) ? 3 : 0
    const column = x + swatch + 2
    add("input", x + swatch, controlWidth - swatch, { kind: "field", index, column })
  }
  return { lines, targets }
}

export function frameSettingsPage(
  title: string,
  innerRows: readonly string[],
  width: number,
  room: number,
  ctx: RenderContext,
): string[] {
  const border = ctx.theme.accent
  const side = ctx.glyphs?.codeSide ?? "│"
  const label = truncateToWidth(title, Math.max(0, width - 6), viewEllipsis())
  const top =
    border(`${glyphs.boxTopLeft}${glyphs.rule} `) +
    label +
    border(` ${glyphs.rule.repeat(Math.max(0, width - 5 - visibleWidth(label)))}${glyphs.boxTopRight}`)
  const bottom = border(`${glyphs.boxBottomLeft}${glyphs.rule.repeat(width - 2)}${glyphs.boxBottomRight}`)
  return [
    top,
    ...innerRows.map((line) => {
      const fit = closeStyles(truncateToWidth(line, room, viewEllipsis()))
      return `${border(side)} ${fit}${" ".repeat(Math.max(0, room - visibleWidth(fit)))} ${border(side)}`
    }),
    bottom,
  ]
}
