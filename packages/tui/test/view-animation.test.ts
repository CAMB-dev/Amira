import { expect, test } from "bun:test"
import type { ViewDefinition } from "@amira/api"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { ExtensionViewer } from "../src/extension-view.ts"

function render(definition: ViewDefinition, width = 40, focused = true) {
  const viewer = new ExtensionViewer(definition, undefined)
  viewer.focused = focused
  const rows = viewer.render(width, { ...plain, theme: defaultTheme })
  expect(rows.join("\n")).not.toContain("amira-view-animation")
  return { viewer, rows: rows.map(stripAnsi) }
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
