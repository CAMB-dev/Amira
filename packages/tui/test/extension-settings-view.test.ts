import { expect, test } from "bun:test"
import type {
  ExtensionSettingField,
  ExtensionSettingsPreviewContext,
  ExtensionSettingsValues,
  MarkdownRenderResult,
} from "@amira/api"
import {
  defaultTheme,
  ImageStore,
  key,
  type RenderContext,
  stripAnsi,
  textKey,
  visibleWidth,
} from "@amira/tui-kit"
import { fakeProvider } from "../../tui-kit/test/fake-images.ts"
import {
  type ExtensionSettingsRequest,
  ExtensionSettingsView,
  type ExtensionSettingsViewOptions,
  type SettingsPageBackend,
} from "../src/extension-settings-view.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { setup, waitFor } from "./app-harness.ts"

const fields: ExtensionSettingField[] = [
  {
    key: "size",
    type: "number",
    label: "Font size",
    default: 16,
    min: 8,
    max: 32,
    step: 2,
    description: "Size of labels in the diagram, in pixels.",
  },
  {
    key: "style",
    type: "choice",
    label: "Style",
    default: "plain",
    options: ["plain", { value: "bold", label: "Bold labels" }],
  },
  { key: "enabled", type: "toggle", label: "Show labels", default: true },
  { key: "name", type: "text", label: "Name", default: "ok", pattern: "[a-z]+", maxLength: 8 },
  { key: "colour", type: "colour", label: "Colour", default: "#abcdef" },
]
const defaults: ExtensionSettingsValues = {
  size: 16,
  style: "plain",
  enabled: true,
  name: "ok",
  colour: "#abcdef",
}

function page(
  overrides: Partial<SettingsPageBackend> = {},
  options: Partial<ExtensionSettingsViewOptions> = {},
) {
  const request: ExtensionSettingsRequest = {
    kind: "extension-settings",
    requestId: "settings-test",
    name: "diagrams",
    title: "Diagram settings",
    fields: structuredClone(fields),
    values: structuredClone(defaults),
    scope: "project",
  }
  const saved: { values: ExtensionSettingsValues; scope: "user" | "project" }[] = []
  let cancelled = 0
  let closed = 0
  let renders = 0
  const backend: SettingsPageBackend = {
    request,
    submit: async (values, scope) => {
      saved.push({ values, scope })
      return undefined
    },
    cancel: () => {
      cancelled++
    },
    ...overrides,
  }
  const view = new ExtensionSettingsView(backend, {
    onClose: () => {
      closed++
    },
    requestRender: () => {
      renders++
    },
    ...options,
  })
  const ctx: RenderContext = { theme: defaultTheme, color: true, rows: 22 }
  const rows = (width = 60, context = ctx) => view.render(width, context)
  const plain = (width = 60, context = ctx) => rows(width, context).map(stripAnsi).join("\n")
  return {
    view,
    backend,
    saved,
    rows,
    plain,
    ctx,
    cancelled: () => cancelled,
    closed: () => closed,
    renders: () => renders,
  }
}

const tick = async () => {
  await Bun.sleep(0)
}

test("number steppers have visible ANSI focus, clamp typed numbers, and reset only the focused draft field", () => {
  const p = page()
  const row = p.rows().find((line) => stripAnsi(line).includes("Font size"))!
  expect(stripAnsi(row)).toContain(`${glyphs.pointer} Font size  - 16 +`)
  expect(row).toContain("\x1b[7m")
  expect(row).toContain(defaultTheme.borderFocused("-"))
  expect(row).toContain(defaultTheme.borderFocused("+"))
  p.view.handleInput(key("right"))
  expect(p.view.values.size).toBe(18)
  expect(p.plain()).toContain("Font size *")
  p.view.handleInput(textKey("+"))
  p.view.handleInput(textKey("-"))
  expect(p.view.values.size).toBe(18)
  p.view.handleInput({ type: "paste", text: "999" })
  expect(p.view.values.size).toBe(32)
  expect(p.rows().find((line) => stripAnsi(line).includes("Font size"))).toContain(defaultTheme.muted("+"))
  p.view.handleInput(key("r", { ctrl: true }))
  expect(p.view.values).toEqual(defaults)
  p.view.handleInput(textKey("1"))
  p.view.handleInput(textKey("6"))
  expect(p.view.values.size).toBe(16)
  expect(p.saved).toEqual([])
  expect(p.backend.request.values).toEqual(defaults)
})

test("steppers stay on a valid step when the maximum is between steps", () => {
  const p = page()
  const field = p.backend.request.fields[0]!
  if (field.type !== "number") throw new Error("expected number field")
  field.max = 31
  p.view.handleInput({ type: "paste", text: "999" })
  expect(p.view.values.size).toBe(30)
  p.view.handleInput(key("right"))
  expect(p.view.values.size).toBe(30)
})

test("text placeholders are shown for an empty single-line control", () => {
  const p = page()
  const field = p.backend.request.fields[3]!
  if (field.type !== "text") throw new Error("expected text field")
  field.placeholder = "display name"
  for (let i = 0; i < 3; i++) p.view.handleInput(key("down"))
  p.view.handleInput(key("u", { ctrl: true }))
  expect(p.view.values.name).toBe("")
  expect(p.plain()).toContain("display name")
  expect(p.saved).toEqual([])
})

test("text truncation preserves Unicode code points before Enter saves", async () => {
  const p = page()
  const field = p.backend.request.fields[3]!
  if (field.type !== "text") throw new Error("expected text field")
  field.pattern = undefined
  field.maxLength = 4
  for (let i = 0; i < 3; i++) p.view.handleInput(key("down"))
  p.view.handleInput(key("u", { ctrl: true }))
  p.view.handleInput({ type: "paste", text: "abc🚀x" })
  expect(p.view.values.name).toBe("abc🚀")
  expect(String(p.view.values.name).isWellFormed()).toBe(true)
  p.view.handleInput(key("enter"))
  p.view.handleInput(key("enter"))
  await tick()
  expect(p.saved).toEqual([{ values: { ...defaults, name: "abc🚀" }, scope: "project" }])
})

test("choices cycle, toggles use space, text honours pattern/maxLength, and colour input shows a real swatch", () => {
  const p = page()
  p.view.handleInput(key("down"))
  p.view.handleInput(key("left"))
  expect(p.view.values.style).toBe("bold")
  expect(p.plain()).toContain("Bold labels")
  p.view.handleInput(key("right"))
  expect(p.view.values.style).toBe("plain")
  p.view.handleInput(key("down"))
  p.view.handleInput(key("space"))
  expect(p.view.values.enabled).toBe(false)
  expect(p.plain()).toContain("Show labels *  off")
  p.view.handleInput(key("down"))
  p.view.handleInput(key("u", { ctrl: true }))
  p.view.handleInput({ type: "paste", text: "0123456789" })
  expect(p.view.values.name).toBe("01234567")
  p.view.handleInput(key("enter"))
  expect(p.plain()).toContain("must match the declared pattern")
  expect(p.plain()).not.toContain("save settings to")
  p.view.handleInput(key("r", { ctrl: true }))
  p.view.handleInput(textKey("r"))
  expect(p.view.values.name).toBe("okr")
  p.view.handleInput(key("down"))
  p.view.handleInput(key("u", { ctrl: true }))
  p.view.handleInput({ type: "paste", text: "#112233" })
  expect(p.view.values.colour).toBe("#112233")
  expect(p.rows().join("\n")).toContain("\x1b[38;2;17;34;51m")
  expect(p.saved).toEqual([])
})

test("Enter chooses user/project inline using provenance; a second Enter saves, Esc discards", async () => {
  const p = page()
  p.view.handleInput(key("right"))
  p.view.handleInput(key("enter"))
  expect(p.plain()).toContain("save settings to")
  expect(p.rows().join("\n")).toContain("[ project ]")
  expect(p.saved).toEqual([])
  p.view.handleInput(key("left"))
  p.view.handleInput(key("enter"))
  await tick()
  expect(p.saved).toEqual([{ values: { ...defaults, size: 18 }, scope: "user" }])
  expect(p.closed()).toBe(1)
  const discarded = page()
  discarded.view.handleInput(key("right"))
  discarded.view.handleInput(key("enter"))
  discarded.view.handleInput(key("escape"))
  expect(discarded.saved).toEqual([])
  expect(discarded.cancelled()).toBe(1)
  expect(discarded.closed()).toBe(1)
})

test("save failures are visible and editable without discarding the request", async () => {
  const p = page({ submit: async () => "Settings file is read-only" })
  p.view.handleInput(key("enter"))
  p.view.handleInput(key("enter"))
  await tick()
  expect(p.view.closed).toBe(false)
  expect(p.plain()).toContain("Settings file is read-only")
  p.view.handleInput(key("right"))
  expect(p.view.values.size).toBe(18)
})

test("async previews discard superseded generations, abort on resize/close, and request redraw after completion", async () => {
  const pending: {
    draft: ExtensionSettingsValues
    ctx: ExtensionSettingsPreviewContext
    resolve: (result: MarkdownRenderResult) => void
  }[] = []
  const p = page(
    {
      preview: (draft, ctx) =>
        new Promise((resolve) => {
          pending.push({ draft, ctx, resolve })
        }),
    },
    {
      previewTheme: () => ({ dark: false, foreground: "#112233", background: "#ffffff" }),
    },
  )
  p.rows()
  await tick()
  expect(pending[0]?.ctx).toMatchObject({
    width: 60,
    images: false,
    maxImageRows: 0,
    theme: { dark: false, foreground: "#112233" },
  })
  p.view.handleInput(key("right"))
  expect(pending[0]?.ctx.signal.aborted).toBe(true)
  p.rows()
  await tick()
  expect(pending[1]?.draft.size).toBe(18)
  pending[1]!.resolve({ lines: [{ kind: "accent", text: "new preview 18" }] })
  await tick()
  expect(p.plain()).toContain("new preview 18")
  const before = p.renders()
  pending[0]!.resolve({ lines: [{ kind: "text", text: "stale preview 16" }] })
  await tick()
  expect(p.plain()).not.toContain("stale preview")
  expect(p.renders()).toBe(before)
  p.rows(30)
  await tick()
  expect(pending[1]?.ctx.signal.aborted).toBe(true)
  p.view.close()
  expect(pending[2]?.ctx.signal.aborted).toBe(true)
})

test("image previews use ImageStore screen placement, redraw after opening/encoding, and retain alt fallback", async () => {
  const provider = fakeProvider()
  const images = new ImageStore({
    support: { protocol: "kitty", cell: { width: 10, height: 20 } },
    cwd: "/test",
    maxRows: () => 8,
    open: provider.open,
  })
  const p = page(
    { preview: () => ({ image: { url: "diagram-40x60.png" }, alt: "diagram fallback" }) },
    { images: () => images },
  )
  const placements: Parameters<NonNullable<RenderContext["place"]>>[0][] = []
  const ctx = { ...p.ctx, place: (placement: (typeof placements)[number]) => placements.push(placement) }
  p.rows(60, ctx)
  await tick()
  expect(p.plain(60, ctx)).toContain("diagram fallback")
  await tick()
  p.rows(60, ctx)
  await tick()
  const rendered = p.plain(60, ctx)
  expect(placements).toHaveLength(1)
  expect(placements[0]).toMatchObject({ row: 1, col: 0, from: 0, to: 3 })
  expect(placements[0]?.image.ready).toBe(true)
  expect(rendered).not.toContain("diagram fallback")
  expect(provider.opened).toEqual(["diagram-40x60.png"])
  expect(provider.encoded).toHaveLength(1)
  expect(p.renders()).toBeGreaterThan(2)
  const without = page({ preview: () => ({ image: { url: "diagram-40x60.png" }, alt: "diagram fallback" }) })
  without.rows()
  await tick()
  expect(without.plain()).toContain("diagram fallback")
})

test("narrow ASCII layouts keep focused controls, wrapped muted descriptions and lower-case action keys visible", () => {
  try {
    setGlyphs({ pointer: ">", more: "...", separator: "|" })
    const p = page()
    const ctx = { ...p.ctx, rows: 9 }
    const rows = p.rows(24, ctx)
    expect(rows).toHaveLength(9)
    expect(rows.every((row) => visibleWidth(row) <= 24)).toBe(true)
    expect(rows.join("\n")).toContain(defaultTheme.muted("of labels in the"))
    const plain = rows.map(stripAnsi).join("\n")
    expect(plain).toContain("> Font size")
    expect(plain).toContain("- 16 +")
    expect(plain).toContain("up/down focus")
    expect(plain).toContain("enter save")
    expect(plain).toContain("esc discard")
    expect(plain).toContain("ctrl+r reset")
    p.view.handleInput(key("down"))
    expect(p.plain(24, ctx)).toContain("< plain >")
  } finally {
    setGlyphs()
  }
})

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: settings use the overlay, queue dialogs, draw preview images and restore the composer`, async () => {
    const provider = fakeProvider()
    const s = await setup([], {
      cols: 60,
      rows: 22,
      settings: { mode },
      env: { WT_SESSION: "test" },
      graphics: { answered: true, sixel: true, kitty: false, cell: { width: 10, height: 20 } },
      images: { id: "settings-images", open: provider.open },
    })
    const saved: ExtensionSettingsValues[] = []
    s.host.ui.setExtensionSettingsAccessor(() => ({
      title: "Diagram settings",
      fields,
      get: () => defaults,
      defaultScope: "project",
      preview: async (draft) => ({
        image: { url: `preview-${draft.size}-40x60.png` },
        alt: "diagram fallback",
      }),
      save: async (values) => {
        saved.push(values)
      },
    }))
    try {
      s.terminal.send("draft composer")
      const answer = s.host.ui.api("commands").extensionSettings("diagrams")
      await waitFor(() => s.live().includes("Diagram settings"), "settings overlay")
      expect(s.screen.inAltScreen).toBe(true)
      await waitFor(() => s.screen.images.length > 0, "preview pixels")
      const later = s.host.ui.api("other").confirm("Deploy too?")
      await s.bus.flush()
      s.terminal.send("\x1b[C\r\r")
      expect(await answer).toEqual({ values: { ...defaults, size: 18 }, scope: "project" })
      expect(saved).toEqual([{ ...defaults, size: 18 }])
      await waitFor(() => s.live().includes("Deploy too?"), "queued dialog")
      s.terminal.send("\x1b[B\r")
      expect(await later).toBe(true)
      await waitFor(() => s.live().includes("draft composer"), "restored input")
      expect(s.agent.messages).toEqual([])
    } finally {
      s.host.ui.cancelAll()
      s.terminal.send("\x15\x03\x03")
      await s.exited
    }
  })
}
