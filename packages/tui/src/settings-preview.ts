// Live preview stages (inline Layout mini-map, inline animated Theme stage, and centered translucent
// floating preview card over the live dimmed conversation) for the fullscreen /settings view.
import {
  bold,
  chromeGlyphs,
  inverse,
  type RenderContext,
  Spinner,
  themeToken,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { paintShimmer } from "./app/shimmer.ts"
import { glyphs, viewEllipsis } from "./glyphs.ts"
import { contentGeometry } from "./margins.ts"
import type { EditableTuiKey, EditableTuiSettings, SettingsField } from "./settings-schema.ts"

export type FieldControlAction =
  | { kind: "focus"; index: number }
  | { kind: "set"; index: number; key: EditableTuiKey; value: EditableTuiSettings[EditableTuiKey] }
  | { kind: "step"; index: number; key: "margin" | "marginRows" | "shellOutputLines"; delta: -1 | 1 }

export interface PreviewHit<A> {
  id: string
  x: number
  y: number
  width: number
  action: A
}

/** Compact centered floating card width so the live dimmed conversation shows widely around all 4 sides. */
export function floatingPreviewCardWidth(terminalWidth: number): number {
  return Math.max(48, Math.min(terminalWidth - 8, 72))
}

function padCell(text: string, width: number): string {
  const cut = truncateToWidth(text, width, viewEllipsis())
  const rem = Math.max(0, width - visibleWidth(cut))
  return cut + " ".repeat(rem)
}

function boxBorder(
  left: string,
  fill: string,
  right: string,
  width: number,
  style: (s: string) => string,
  title?: string,
): string {
  if (!title) return style(left + fill.repeat(Math.max(0, width - 2)) + right)
  const room = Math.max(0, width - 5)
  const head = truncateToWidth(title, room, viewEllipsis())
  const tail = Math.max(0, width - 5 - visibleWidth(head))
  return style(`${left}${fill} `) + head + style(` ${fill.repeat(tail)}${right}`)
}

function renderStageHeader<A>(
  label: string,
  buttonLabel: string,
  buttonAction: A,
  width: number,
  ctx: RenderContext,
  rowY: number,
  addTarget: (hit: PreviewHit<A>) => void,
): string {
  const { theme } = ctx
  const rawBtn = `[ ${buttonLabel} ]`
  const btnWidth = visibleWidth(rawBtn)
  const styledBtn = ctx.color ? inverse(bold(theme.accent(rawBtn))) : bold(theme.accent(rawBtn))
  const leftText = bold(theme.fg2(label))
  const leftWidth = visibleWidth(leftText)
  if (leftWidth + btnWidth + 3 <= width) {
    const gap = width - leftWidth - btnWidth
    addTarget({ id: "preview:open", x: leftWidth + gap, y: rowY, width: btnWidth, action: buttonAction })
    return leftText + " ".repeat(gap) + styledBtn
  }
  const cutLeft = truncateToWidth(leftText, Math.max(1, width - btnWidth - 2), viewEllipsis())
  const gap = Math.max(1, width - visibleWidth(cutLeft) - btnWidth)
  addTarget({
    id: "preview:open",
    x: visibleWidth(cutLeft) + gap,
    y: rowY,
    width: btnWidth,
    action: buttonAction,
  })
  return cutLeft + " ".repeat(gap) + styledBtn
}

/** Inline visual layout mini-map showing outer margin cells and live conversation dimensions. */
export function renderLayoutPreviewStage<A>(opts: {
  draft: EditableTuiSettings
  viewport: { columns: number; rows: number }
  width: number
  compact: boolean
  ctx: RenderContext
  ascii: boolean
  startY: number
  openAction: A
  addTarget: (hit: PreviewHit<A>) => void
}): string[] {
  const { draft, viewport, width, compact, ctx, ascii, startY, openAction, addTarget } = opts
  const { theme } = ctx
  const geom = contentGeometry(viewport.columns, viewport.rows, {
    margin: draft.margin,
    marginRows: draft.marginRows,
  })
  const lines: string[] = []
  const icon = ascii ? "*" : "◐"
  lines.push(
    renderStageHeader(
      "Layout Preview",
      `${icon} Live preview on chat (P)`,
      openAction,
      width,
      ctx,
      startY,
      addTarget,
    ),
  )

  const boxWidth = Math.max(24, width)
  const inner = boxWidth - 2
  const tl = ascii ? "+" : "┌"
  const tr = ascii ? "+" : "┐"
  const bl = ascii ? "+" : "└"
  const br = ascii ? "+" : "┘"
  const h = ascii ? "-" : "─"
  const v = ascii ? "|" : "│"
  const shadeChar = ascii ? "." : "░"

  lines.push(boxBorder(tl, h, tr, boxWidth, theme.border))

  // Visual horizontal margin scaling (1:1 up to half the inner box minus room for inner label).
  const maxVisualMargin = Math.max(0, Math.floor((inner - 26) / 2))
  const visualMargin = Math.min(draft.margin, maxVisualMargin)
  const contentBoxWidth = Math.max(16, inner - visualMargin * 2)
  const contentInner = Math.max(1, contentBoxWidth - 2)
  const marginPad = visualMargin > 0 ? theme.dim(shadeChar.repeat(visualMargin)) : ""
  const padRow = (content: string) => theme.border(v) + padCell(content, inner) + theme.border(v)

  if (!compact && draft.marginRows > 0) {
    const label = ` top padding: ${draft.marginRows} row${draft.marginRows === 1 ? "" : "s"} `
    const fillLeft = Math.max(0, Math.floor((inner - label.length) / 2))
    const fillRight = Math.max(0, inner - fillLeft - label.length)
    lines.push(
      padRow(
        theme.dim(shadeChar.repeat(fillLeft)) + theme.muted(label) + theme.dim(shadeChar.repeat(fillRight)),
      ),
    )
  }

  const innerTop = marginPad + theme.accent(tl + h.repeat(contentInner) + tr) + marginPad
  const dimLine = `Conversation ${geom.width}×${geom.height} (terminal ${viewport.columns}×${viewport.rows})`
  const infoLine = `Side margin: ${draft.margin} cells · Top/bottom: ${draft.marginRows} rows · Shell tail: ${draft.shellOutputLines}`
  const innerMid1 =
    marginPad +
    theme.accent(v) +
    padCell(` ${bold(theme.text(dimLine))}`, contentInner) +
    theme.accent(v) +
    marginPad
  const innerMid2 =
    marginPad +
    theme.accent(v) +
    padCell(` ${theme.muted(infoLine)}`, contentInner) +
    theme.accent(v) +
    marginPad
  const innerBot = marginPad + theme.accent(bl + h.repeat(contentInner) + br) + marginPad

  if (compact) {
    lines.push(padRow(innerMid1))
  } else {
    lines.push(padRow(innerTop))
    lines.push(padRow(innerMid1))
    lines.push(padRow(innerMid2))
    lines.push(padRow(innerBot))
  }

  if (!compact && draft.marginRows > 0) {
    const label = ` bottom padding: ${draft.marginRows} row${draft.marginRows === 1 ? "" : "s"} `
    const fillLeft = Math.max(0, Math.floor((inner - label.length) / 2))
    const fillRight = Math.max(0, inner - fillLeft - label.length)
    lines.push(
      padRow(
        theme.dim(shadeChar.repeat(fillLeft)) + theme.muted(label) + theme.dim(shadeChar.repeat(fillRight)),
      ),
    )
  }

  lines.push(boxBorder(bl, h, br, boxWidth, theme.border))
  return lines
}

/** Inline live Theme & Shimmer preview stage showing real theme tokens, diffs, badges, and shimmer. */
export function renderThemePreviewStage<A>(opts: {
  draft: EditableTuiSettings
  width: number
  compact: boolean
  ctx: RenderContext
  ascii: boolean
  nowMs: number
  startY: number
  openAction: A
  addTarget: (hit: PreviewHit<A>) => void
}): string[] {
  const { draft, width, compact, ctx, ascii, nowMs, openAction, addTarget } = opts
  const { theme } = ctx
  const lines: string[] = []
  const icon = ascii ? "*" : "◐"
  lines.push(
    renderStageHeader(
      `Theme Preview · ${draft.theme} (${draft.themeVariant})`,
      `${icon} Live preview on chat (P)`,
      openAction,
      width,
      ctx,
      opts.startY,
      addTarget,
    ),
  )

  const boxWidth = Math.max(24, width)
  const inner = boxWidth - 2
  const tl = ascii ? "+" : "┌"
  const tr = ascii ? "+" : "┐"
  const bl = ascii ? "+" : "└"
  const br = ascii ? "+" : "┘"
  const h = ascii ? "-" : "─"
  const v = ascii ? "|" : "│"
  const padRow = (content: string) => theme.border(v) + padCell(content, inner) + theme.border(v)

  const frames = chromeGlyphs(ctx.glyphs).spinnerFrames
  const spinChar = frames[Math.floor(nowMs / Spinner.INTERVAL_MS) % frames.length] ?? "*"
  const shimmerStyle = themeToken(theme, "shimmer") ?? theme.accent
  const diffAdd = themeToken(theme, "diffAdd") ?? theme.success
  const diffDel = themeToken(theme, "diffRemove") ?? theme.error

  const hdrLeft = ` ${theme.path("~/project")} ${theme.muted(glyphs.separator)} ${theme.accent("main*")}`
  const hdrRight = `${theme.muted("12.4k / 200k")} `
  const hdrGap = Math.max(1, inner - visibleWidth(hdrLeft) - visibleWidth(hdrRight))
  const headerSample = hdrLeft + " ".repeat(hdrGap) + hdrRight

  const userSample = ` ${bold(theme.accent(glyphs.user))} ${theme.text("Preview the active theme, badges, diffs, and shimmer")}`
  const replySample =
    ` ${theme.accent(glyphs.info)} ${theme.fg2("Tokens:")} ` +
    `${theme.success(`${glyphs.success} pass`)}  ` +
    `${theme.warning(`${glyphs.warning} warn`)}  ` +
    `${theme.error(`${glyphs.error} err`)}  ` +
    `${theme.command("`code`")}`
  const diffSample = ` ${diffAdd("+ live theme & shimmer preview")}   ${diffDel("- restart required")}`
  const shimmerSample = ` ${shimmerStyle(spinChar)} ${paintShimmer("Thinking · live theme & shimmer preview…", ctx, nowMs)}`

  lines.push(boxBorder(tl, h, tr, boxWidth, theme.border))
  if (compact) {
    lines.push(padRow(replySample))
    lines.push(padRow(shimmerSample))
  } else {
    lines.push(padRow(headerSample))
    lines.push(padRow(userSample))
    lines.push(padRow(replySample))
    lines.push(padRow(diffSample))
    lines.push(padRow(shimmerSample))
  }
  lines.push(boxBorder(bl, h, br, boxWidth, theme.border))
  return lines
}

/**
 * Renders the centered floating preview card positioned in terminal coordinates so `fullscreen-view.ts`
 * composites the live dimmed conversation on all 4 sides around it.
 */
export function renderFloatingPreviewCard<A>(opts: {
  title: string
  bodyLines: string[]
  bodyTargets: PreviewHit<A>[]
  width: number
  ctx: RenderContext
  ascii: boolean
  okAction: A
  cancelAction: A
}): { rows: string[]; targets: PreviewHit<A>[] } {
  const { title, bodyLines, bodyTargets, width, ctx, ascii, okAction, cancelAction } = opts
  const { theme } = ctx
  const floating = width >= 60 && ctx.rows >= 20
  const cardWidth = floating ? floatingPreviewCardWidth(width) : width
  const left = floating ? Math.floor((width - cardWidth) / 2) : 0
  const inner = Math.max(10, cardWidth - 4)

  const tl = ascii ? "+" : "╭"
  const tr = ascii ? "+" : "╮"
  const bl = ascii ? "+" : "╰"
  const br = ascii ? "+" : "╯"
  const h = ascii ? "-" : "─"
  const v = ascii ? "|" : "│"

  // Build centered [ OK ]   [ Cancel ] button bar
  const okRaw = "[ OK ]"
  const cancelRaw = "[ Cancel ]"
  const okStyled = ctx.color ? inverse(bold(theme.accent(okRaw))) : bold(theme.accent(okRaw))
  const cancelStyled = theme.fg2(cancelRaw)
  const gap = "    "
  const totalBtnWidth = visibleWidth(okRaw) + gap.length + visibleWidth(cancelRaw)
  const btnLead = Math.max(0, Math.floor((inner - totalBtnWidth) / 2))
  const btnLine = " ".repeat(btnLead) + okStyled + gap + cancelStyled

  const contentLines: string[] = ["", ...bodyLines, "", theme.border(h.repeat(inner)), btnLine]
  const btnRowIdx = contentLines.length - 1

  const framed: string[] = []
  const topTitle = bold(theme.accent(title))
  framed.push(boxBorder(tl, h, tr, cardWidth, theme.borderFocused, topTitle))
  for (const line of contentLines) {
    framed.push(`${theme.borderFocused(v)} ${padCell(line, inner)} ${theme.borderFocused(v)}`)
  }
  framed.push(boxBorder(bl, h, br, cardWidth, theme.borderFocused))

  const top = Math.max(0, Math.floor((ctx.rows - framed.length) / 2))
  const output = Array<string>(ctx.rows).fill("")
  const indent = " ".repeat(left)
  for (let i = 0; i < framed.length && top + i < ctx.rows; i++) {
    output[top + i] = indent + framed[i]!
  }

  const targets: PreviewHit<A>[] = []
  // Body targets are relative to bodyLines (which starts at contentLines index 1, framed index 2).
  for (const hit of bodyTargets) {
    const y = top + 2 + hit.y
    if (y >= 0 && y < ctx.rows) {
      targets.push({ ...hit, x: left + 2 + hit.x, y })
    }
  }
  const btnY = top + 1 + btnRowIdx
  if (btnY >= 0 && btnY < ctx.rows) {
    targets.push({
      id: "floating:ok",
      x: left + 2 + btnLead,
      y: btnY,
      width: visibleWidth(okRaw),
      action: okAction,
    })
    targets.push({
      id: "floating:cancel",
      x: left + 2 + btnLead + visibleWidth(okRaw) + gap.length,
      y: btnY,
      width: visibleWidth(cancelRaw),
      action: cancelAction,
    })
  }
  return { rows: output, targets }
}

/** Renders clickable GUI pill-button controls for a list of settings fields. */
export function renderSettingsFieldRows(opts: {
  fields: readonly SettingsField[]
  draft: EditableTuiSettings
  fieldFocus: number
  optionsOf: (
    field: Extract<SettingsField, { kind: "choice" }>,
  ) => readonly { value: EditableTuiSettings[EditableTuiKey]; label: string }[]
  inner: number
  vp: { columns: number; rows: number }
  ctx: RenderContext
  ascii: boolean
  startY: number
  allowWrap?: boolean
  addTarget: (target: PreviewHit<FieldControlAction>) => void
}): string[] {
  const { fields, draft, fieldFocus, optionsOf, inner, vp, ctx, ascii, startY, allowWrap, addTarget } = opts
  const { theme } = ctx
  const lines: string[] = []
  const labelCol = Math.min(20, Math.max(12, ...fields.map((f) => visibleWidth(f.label) + 4)))
  const controlRoom = Math.max(12, inner - labelCol - 1)

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    const focused = i === fieldFocus
    const value = draft[field.key]
    const modified = value !== field.defaultValue
    const mark = focused ? bold(theme.accent(glyphs.pointer)) : " "
    const rawLabel = `${field.label}${modified ? "*" : ""}`
    const pad = " ".repeat(Math.max(1, labelCol - 2 - visibleWidth(rawLabel)))
    const labelPart = `${mark} ${focused ? bold(theme.accent(rawLabel)) : theme.text(rawLabel)}${pad}`

    const pill = (text: string, active: boolean, disabled = false): string => {
      const raw = `[ ${text} ]`
      if (disabled) return theme.dim(raw)
      if (active) {
        return focused && ctx.color ? inverse(bold(theme.accent(raw))) : bold(theme.accent(raw))
      }
      return focused ? theme.fg2(raw) : theme.muted(raw)
    }

    const controls: { text: string; raw: string; action: FieldControlAction }[] = []
    let suffix = ""
    if (field.kind === "number") {
      const current = value as number
      const presets = field.presets.includes(current)
        ? field.presets
        : [...field.presets, current].sort((a, b) => a - b)
      const needStepper = field.max - field.min > 2
      const fullWidth = (needStepper ? 12 : 0) + presets.reduce((sum, n) => sum + `[ ${n} ]`.length + 1, 0)
      if (fullWidth <= controlRoom || (allowWrap && fullWidth <= inner - 4)) {
        if (needStepper) {
          controls.push({
            text: pill("-", false, current <= field.min),
            raw: "[ - ]",
            action: { kind: "step", index: i, key: field.key, delta: -1 },
          })
        }
        for (const preset of presets) {
          controls.push({
            text: pill(String(preset), preset === current),
            raw: `[ ${preset} ]`,
            action: { kind: "set", index: i, key: field.key, value: preset },
          })
        }
        if (needStepper) {
          controls.push({
            text: pill("+", false, current >= field.max),
            raw: "[ + ]",
            action: { kind: "step", index: i, key: field.key, delta: 1 },
          })
        }
      } else {
        controls.push(
          {
            text: pill("-", false, current <= field.min),
            raw: "[ - ]",
            action: { kind: "step", index: i, key: field.key, delta: -1 },
          },
          { text: pill(String(current), true), raw: `[ ${current} ]`, action: { kind: "focus", index: i } },
          {
            text: pill("+", false, current >= field.max),
            raw: "[ + ]",
            action: { kind: "step", index: i, key: field.key, delta: 1 },
          },
        )
      }
      if (field.liveSuffix) suffix = ` ${theme.muted(field.liveSuffix(draft, vp))}`
    } else if (field.kind === "toggle") {
      const on = value === true
      controls.push(
        {
          text: pill("On", on),
          raw: "[ On ]",
          action: { kind: "set", index: i, key: field.key, value: true },
        },
        {
          text: pill("Off", !on),
          raw: "[ Off ]",
          action: { kind: "set", index: i, key: field.key, value: false },
        },
      )
    } else {
      const optionsList = optionsOf(field)
      const current = String(value)
      const allWidth = optionsList.reduce((sum, o) => sum + `[ ${o.label} ]`.length + 1, 0)
      if (allWidth <= controlRoom) {
        for (const opt of optionsList) {
          controls.push({
            text: pill(opt.label, String(opt.value) === current),
            raw: `[ ${opt.label} ]`,
            action: { kind: "set", index: i, key: field.key, value: opt.value },
          })
        }
      } else {
        const idx = Math.max(
          0,
          optionsList.findIndex((o) => String(o.value) === current),
        )
        const chosen = optionsList[idx]?.label ?? current
        const prev = optionsList[(idx - 1 + optionsList.length) % optionsList.length]!
        const next = optionsList[(idx + 1) % optionsList.length]!
        controls.push(
          {
            text: pill(ascii ? "<" : "‹", false),
            raw: `[ ${ascii ? "<" : "‹"} ]`,
            action: { kind: "set", index: i, key: field.key, value: prev.value },
          },
          { text: pill(chosen, true), raw: `[ ${chosen} ]`, action: { kind: "focus", index: i } },
          {
            text: pill(ascii ? ">" : "›", false),
            raw: `[ ${ascii ? ">" : "›"} ]`,
            action: { kind: "set", index: i, key: field.key, value: next.value },
          },
        )
      }
    }

    const controlsRawWidth = controls.reduce((s, c, idx) => s + visibleWidth(c.raw) + (idx ? 1 : 0), 0)
    const inline = labelCol + controlsRawWidth <= inner
    const rowY = startY + lines.length
    addTarget({
      id: `row:${i}`,
      x: 0,
      y: rowY,
      width: Math.min(inner, labelCol),
      action: { kind: "focus", index: i },
    })

    let controlLine = ""
    const baseX = inline ? visibleWidth(labelPart) : 2
    const controlY = inline ? rowY : rowY + 1
    for (let c = 0; c < controls.length; c++) {
      const item = controls[c]!
      if (c > 0) controlLine += " "
      const x = baseX + visibleWidth(controlLine)
      const w = visibleWidth(item.raw)
      if (x + w <= inner) {
        addTarget({ id: `ctrl:${i}:${c}`, x, y: controlY, width: w, action: item.action })
      }
      controlLine += item.text
    }
    const controlWithSuffix =
      suffix && baseX + visibleWidth(controlLine) + visibleWidth(suffix) <= inner
        ? controlLine + suffix
        : controlLine

    if (inline) lines.push(labelPart + controlWithSuffix)
    else {
      lines.push(labelPart.trimEnd())
      lines.push(`  ${controlWithSuffix}`)
    }
  }
  return lines
}
