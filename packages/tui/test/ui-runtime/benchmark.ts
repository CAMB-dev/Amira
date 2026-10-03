import type { UiNode, UiTreeItem, ViewDefinition } from "@amira/api"
import { key, monoTheme } from "@amira/tui-kit"
import { ExtensionViewer } from "../../src/extension-view.ts"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

/** Reproducible, uncached 500-item nested-tree benchmark. Run with Bun; no terminal or timers. */
const items: UiTreeItem[] = Array.from({ length: 20 }, (_, phase) => ({
  key: `phase-${phase}`,
  row: [{ kind: "accent", text: `Phase ${phase}` }],
  rail: true,
  children: Array.from({ length: 4 }, (_, worker) => ({
    key: `worker-${phase}-${worker}`,
    row: [{ kind: "text", text: `Worker ${worker}: update the shared contract` }],
    rail: true,
    children: Array.from({ length: 5 }, (_, step) => ({
      key: `step-${phase}-${worker}-${step}`,
      row: [{ kind: "muted", text: `Step ${step} · tests and implementation` }],
    })),
  })),
}))
const widgetItems: UiTreeItem[] = items.map((phase) => ({
  ...phase,
  lead: [{ kind: "muted", text: "10:12:31 ✓" }],
  node: [{ kind: "accent", text: "◉" }],
  underline: true,
  children: phase.children!.map((worker) => ({
    ...worker,
    detail: {
      type: "box",
      title: { kind: "segments", parts: [...worker.row, { kind: "chip", text: "TypeScript", tone: "info" }] },
      aside: "running",
      child: {
        type: "column",
        children: [
          { node: { type: "text", lines: [{ kind: "muted", text: "Implement the shared event contract" }] } },
          { node: { type: "progress", value: 0.5, width: 18 } },
          {
            node: {
              type: "table",
              columns: [{ key: "file", label: "Changed files" }],
              rows: [{ key: "api", cells: { file: "packages/api/src/events.ts" } }],
            },
          },
          { node: { type: "bar", left: [{ kind: "accent", text: "Open diff · Pause · Request changes" }] } },
        ],
      },
    },
  })),
}))
const expanded = items.flatMap((p) => [p.key, ...p.children!.map((c) => c.key)])
const mostlyCollapsed = [items[0]!.key, items[0]!.children![0]!.key]
const node: UiNode = { type: "tree", id: "tree", items }
const iterations = 600
const warmup = 100
const ctx = { theme: monoTheme, rows: 50, color: false }

function measure(label: string, frame: (i: number) => void): void {
  for (let i = 0; i < warmup; i++) frame(i)
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    frame(i)
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  console.log(
    `${label}: median=${samples[Math.floor(iterations / 2)]!.toFixed(3)}ms p95=${samples[Math.floor(iterations * 0.95)]!.toFixed(3)}ms (${iterations} iterations, ${warmup} warmup)`,
  )
}

console.log(
  `Bun ${Bun.version}; 500 items (20 phases × (1 + 4 workers + 20 steps)); 180×50; mutate data + move selection + render every sample`,
)
for (const [detailLabel, data] of [
  ["line rows", items],
  ["80 widget cards + timeline styling", widgetItems],
] as const) {
  node.items = data
  console.log(detailLabel)
  for (const [name, keys] of [
    ["expanded", expanded],
    ["mostly collapsed", mostlyCollapsed],
    ["collapsed after expansion (80 retained hidden keys)", expanded.filter((k) => k.startsWith("worker-"))],
  ] as const) {
    const runtime = new UiRuntime(() => {})
    runtime.setState({ expanded: { tree: [...expanded] } })
    const render = () =>
      runtime.render(node, 180, 50, monoTheme, (ls, width) => renderViewLines(ls, monoTheme, width))
    render()
    runtime.setState({ expanded: { tree: [...keys] } })
    render()
    measure(`runtime ${name}`, (i) => {
      items[0]!.row[0]!.text = `Phase 0 · update ${i}`
      runtime.handleInput(key(i % 80 < 40 ? "down" : "up"))
      render()
    })
    let initialize = true
    const definition: ViewDefinition = {
      kind: "tree-benchmark",
      title: () => "Tree benchmark",
      keys: [{ key: "i", label: "" }],
      ui: () => node,
      onEvent: (event, _data, view) => {
        if (event.type === "key" && event.key === "i") {
          view.setState({ expanded: { tree: [...(initialize ? expanded : keys)] } })
          initialize = false
        }
      },
    }
    const viewer = new ExtensionViewer(definition, {}, { now: () => 42_000 })
    viewer.render(180, ctx)
    viewer.handleInput(key("i"))
    viewer.render(180, ctx)
    viewer.handleInput(key("i"))
    viewer.render(180, ctx)
    measure(`ExtensionViewer ${name} (49 content rows + footer)`, (i) => {
      items[0]!.row[0]!.text = `Phase 0 · update ${i}`
      viewer.handleInput(key(i % 80 < 40 ? "down" : "up"))
      viewer.render(180, ctx)
    })
    runtime.dispose()
    viewer.dispose()
  }
}
