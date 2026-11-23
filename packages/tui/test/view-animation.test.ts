import { expect, test } from "bun:test"
import type { ViewDefinition } from "@amira/api"
import { resolveShimmer } from "@amira/core"
import { defaultTheme, monoTheme, type RenderContext, Spinner, stripAnsi, type Theme } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { configureShimmer, SHIMMER_INTERVAL_MS } from "../src/app/shimmer.ts"
import { ExtensionViewer } from "../src/extension-view.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { ELAPSED_INTERVAL_MS } from "../src/view-animation.ts"

function shimmerTheme(): Theme {
  const tokens: Record<string, (s: string) => string> = {}
  for (let i = 0; i < 16; i++) {
    for (let f = 1; f <= 8; f++) {
      tokens[`shimmer${i}Fade${f}`] = (s: string) => `\x1b[38;5;${16 + i * 8 + f}m${s}\x1b[39m`
    }
  }
  return { ...defaultTheme, ...tokens }
}

function render(
  definition: ViewDefinition,
  width = 40,
  focused = true,
  ctxOverrides: Partial<RenderContext> = {},
  now?: () => number,
) {
  const viewer = new ExtensionViewer(definition, undefined, now ? { now } : {})
  viewer.focused = focused
  const rows = viewer.render(width, { ...plain, theme: defaultTheme, ...ctxOverrides })
  expect(rows.join("\n")).not.toContain("amira-view-animation")
  return { viewer, rows: rows.map(stripAnsi), rawRows: rows }
}

test("unused working badge helpers and identical static text do not demand animation", () => {
  const { viewer, rows } = render({
    kind: "unused",
    title: () => "Static",
    render: (_data, opts) => [{ kind: "text", text: opts.statusBadge!("working")[0]!.text }],
  })
  expect(rows.join("\n")).toContain("working")
  expect(viewer.animating).toBe(false)
  expect(viewer.refreshIntervalMs).toBeUndefined()
})

test("extension text cannot inject private animation provenance", () => {
  const injected = "static\x1b]8;id=amira-view-animation;\x07 text"
  const { viewer, rows } = render({
    kind: "injection",
    title: () => "Static",
    render: () => [
      { kind: "text", text: injected },
      { kind: "segments", parts: [{ kind: "text", text: injected }] },
    ],
  })
  expect(rows.join("\n")).toContain("static text")
  expect(viewer.animating).toBe(false)
  expect(viewer.refreshIntervalMs).toBeUndefined()
})

test("badge provenance survives segment copies and title rendering", () => {
  const { viewer, rows } = render({
    kind: "title",
    title: (_data, opts) => ({
      kind: "segments",
      parts: opts.statusBadge!("working").map((part) => ({ ...part })),
    }),
    render: () => [],
  })
  expect(rows[0]).toContain("working")
  expect(viewer.animating).toBe(true)
})

test("horizontal clipping drops badge demand but a surviving spinner glyph still animates", () => {
  let prefix = 40
  const definition: ViewDefinition = {
    kind: "clipped",
    title: () => "Agents",
    render: (_data, opts) => [
      {
        kind: "segments",
        parts: [{ kind: "text", text: "x".repeat(prefix) }, ...opts.statusBadge!("working")],
      },
    ],
  }
  const hidden = render(definition, 20)
  expect(hidden.rows.join("\n")).not.toContain("working")
  expect(hidden.viewer.animating).toBe(false)
  prefix = 18
  const partial = render(definition, 20)
  expect(partial.rows.join("\n")).not.toContain("working")
  expect(partial.rows.join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  expect(partial.viewer.animating).toBe(true)
})

for (const widget of ["tree", "table"] as const) {
  test(`${widget}: an unfocused selected row preserves visible badge demand without leaking provenance`, () => {
    const { viewer, rows } = render(
      {
        kind: widget,
        title: () => "Agents",
        ui: (_data, opts) =>
          widget === "tree"
            ? { type: "tree", id: "agents", items: [{ key: "child", row: opts.statusBadge!("working") }] }
            : {
                type: "table",
                id: "agents",
                columns: [{ key: "status", label: "Status" }],
                rows: [{ key: "child", cells: { status: opts.statusBadge!("working") } }],
              },
      },
      40,
      false,
    )
    expect(rows.join("\n")).toContain("working")
    expect(viewer.animating).toBe(true)
  })
}

test("a dock header clipped by its final height contributes no badge demand", () => {
  const viewer = new ExtensionViewer(
    {
      kind: "header",
      title: () => "Agents",
      header: (_data, opts) => [
        { kind: "text", text: "Static header" },
        { kind: "segments", parts: opts.statusBadge!("working") },
      ],
      render: () => [],
    },
    undefined,
    { placement: "dock" },
  )
  const rows = viewer.render(40, { ...plain, rows: 3 })
  expect(rows.join("\n")).not.toContain("working")
  expect(rows.join("\n")).not.toContain("amira-view-animation")
  expect(viewer.animating).toBe(false)
})

test("custom working badge labels and symbol-only spinners keep visibility-gated animation demand", () => {
  const labeled = render({
    kind: "btw-label",
    title: () => "btw",
    render: (_data, opts) => [
      { kind: "segments", parts: opts.statusBadge!("working", { label: "Thinking…" }) },
    ],
  })
  expect(labeled.rows.join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking…/)
  expect(labeled.viewer.animating).toBe(true)

  const iconOnly = render({
    kind: "btw-icon",
    title: () => "btw",
    render: (_data, opts) => [
      {
        kind: "segments",
        parts: [...opts.statusBadge!("working", { label: "" }), { kind: "muted", text: " Thinking…" }],
      },
    ],
  })
  expect(iconOnly.rows.join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking…/)
  expect(iconOnly.viewer.animating).toBe(true)
})

test("declarative spinner, badge, shimmer, and elapsed segments demand visibility-gated cadences", () => {
  let clock = 5000
  const theme = shimmerTheme()
  configureShimmer(theme, resolveShimmer("soft"))

  // 1. Spinner + shimmer + elapsed combined -> fastest cadence (33ms shimmer) wins
  const combined = render(
    {
      kind: "btw-live",
      title: () => "btw",
      render: () => [
        {
          kind: "segments",
          parts: [
            { kind: "spinner" },
            { kind: "text", text: " " },
            { kind: "shimmer", text: "Thinking…", startedAt: 1000 },
            { kind: "dim", text: " · " },
            { kind: "elapsed", since: 1000, tone: "dim" },
          ],
        },
      ],
    },
    40,
    true,
    { theme, color: true },
    () => clock,
  )
  expect(combined.rows.join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking… · 4s/)
  expect(combined.viewer.animating).toBe(true)
  expect(combined.viewer.refreshIntervalMs).toBe(SHIMMER_INTERVAL_MS)

  // 2. Shimmer disabled or monochrome -> static fallback with zero animation demand
  const offTheme = shimmerTheme()
  configureShimmer(offTheme, resolveShimmer("off"))
  const shimmerOnly: ViewDefinition = {
    kind: "shimmer-only",
    title: () => "Shimmer",
    render: () => [{ kind: "segments", parts: [{ kind: "shimmer", text: "Thinking…", startedAt: 1000 }] }],
  }
  const disabled = render(shimmerOnly, 40, true, { theme: offTheme, color: true }, () => clock)
  expect(disabled.rows.join("\n")).toContain("Thinking…")
  expect(disabled.viewer.animating).toBe(false)
  expect(disabled.viewer.refreshIntervalMs).toBeUndefined()

  const mono = render(shimmerOnly, 40, true, { theme: monoTheme, color: false }, () => clock)
  expect(mono.rows.join("\n")).toContain("Thinking…")
  expect(mono.viewer.animating).toBe(false)
  expect(mono.viewer.refreshIntervalMs).toBeUndefined()

  // 3. Horizontally clipped shimmer drops its 33ms demand
  const clippedShimmer = render(
    {
      kind: "clipped-shimmer",
      title: () => "Clipped",
      render: () => [
        {
          kind: "segments",
          parts: [
            { kind: "text", text: "x".repeat(30) },
            { kind: "shimmer", text: "Thinking…" },
          ],
        },
      ],
    },
    20,
    true,
    { theme, color: true },
    () => clock,
  )
  expect(clippedShimmer.viewer.animating).toBe(false)
  expect(clippedShimmer.viewer.refreshIntervalMs).toBeUndefined()

  // 4. Elapsed-only segment ticks calmly at 1000ms, not 80ms
  const elapsedOnly = render(
    {
      kind: "elapsed-only",
      title: () => "Elapsed",
      render: () => [{ kind: "segments", parts: [{ kind: "elapsed", since: 1000 }] }],
    },
    40,
    true,
    { theme, color: true },
    () => clock,
  )
  expect(elapsedOnly.rows.join("\n")).toContain("4s")
  expect(elapsedOnly.viewer.animating).toBe(false)
  expect(elapsedOnly.viewer.refreshIntervalMs).toBe(ELAPSED_INTERVAL_MS)

  // 5. Declarative queued badge is static; working badge spins at 80ms
  const queued = render({
    kind: "queued-badge",
    title: () => "Queued",
    render: () => [
      { kind: "segments", parts: [{ kind: "badge", state: "queued", label: "Waiting for an agent slot…" }] },
    ],
  })
  expect(queued.rows.join("\n")).toContain("Waiting for an agent slot…")
  expect(queued.viewer.animating).toBe(false)
  expect(queued.viewer.refreshIntervalMs).toBeUndefined()

  const working = render({
    kind: "working-badge",
    title: () => "Working",
    render: () => [{ kind: "segments", parts: [{ kind: "badge", state: "working", label: "Running" }] }],
  })
  expect(working.rows.join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running/)
  expect(working.viewer.animating).toBe(true)
  expect(working.viewer.refreshIntervalMs).toBe(Spinner.INTERVAL_MS)

  // 6. Spoofed shimmer/elapsed markers in untrusted text are stripped and ignored
  const spoofed = render({
    kind: "spoofed",
    title: () => "Static",
    render: () => [
      {
        kind: "segments",
        parts: [
          {
            kind: "text",
            text: "a\x1b]8;id=amira-view-animation-shimmer;\x07b\x1b]8;id=amira-view-animation-elapsed;\x07",
          },
        ],
      },
    ],
  })
  expect(spoofed.rows.join("\n")).toContain("ab")
  expect(spoofed.viewer.refreshIntervalMs).toBeUndefined()
  clock += 1000
})

test("indeterminate progress widgets and ASCII declarative spinners animate cleanly", () => {
  const before = { ...glyphs }
  try {
    setGlyphs({ pointer: ">", rule: "-" })
    let now = 0
    const viewer = new ExtensionViewer(
      {
        kind: "indeterminate",
        title: () => "Loading",
        ui: () => ({
          type: "column",
          children: [
            { size: 1, node: { type: "bar", left: [{ kind: "spinner" }, { kind: "text", text: " Sync" }] } },
            { size: 1, node: { type: "progress", width: 10, label: "Working" } },
          ],
        }),
      },
      undefined,
      { now: () => now },
    )
    const frame1 = viewer.render(30, { ...plain, theme: defaultTheme }).map(stripAnsi)
    expect(frame1.join("\n")).toMatch(/[|/\-\\] Sync/)
    expect(frame1.join("\n")).toContain("---------- Working")
    expect(viewer.animating).toBe(true)
    expect(viewer.refreshIntervalMs).toBe(Spinner.INTERVAL_MS)
    now += Spinner.INTERVAL_MS
    const frame2 = viewer.render(30, { ...plain, theme: defaultTheme }).map(stripAnsi)
    expect(frame2[0]).not.toBe(frame1[0])
  } finally {
    setGlyphs(before)
  }
})
