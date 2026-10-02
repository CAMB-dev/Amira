// PROTOTYPE — not production. Renders each variant through FullScreenRenderer into a
// FakeTerminal + VirtualScreen and prints the text, to check layouts without a real terminal.
//   bun packages/tui/prototypes/orchestration-dashboard/snapshots.ts [cols] [rows] [seconds]
import { FakeTerminal, FullScreenRenderer, key } from "@amira/tui-kit"
import { VirtualScreen } from "../../../tui-kit/test/screen.ts"
import { type App, createApp, handleInput, rootComponent, step } from "./app.ts"
import { variantA } from "./variant-a.ts"
import { variantB } from "./variant-b.ts"
import { variantC } from "./variant-c.ts"
import { variantD } from "./variant-d.ts"

export function snap(app: App, cols: number, rows: number): string {
  const term = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = term.write.bind(term)
  term.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  const r = new FullScreenRenderer(term, rootComponent(app))
  r.open()
  const out = screen.lines.map((l) => l + " ".repeat(Math.max(0, cols - Bun.stringWidth(l)))).join("\n")
  r.close()
  return out
}

export function scenario(seconds: number, data: "workflow" | "swarm", variant: number, sel?: string): App {
  const app = createApp([variantA, variantB, variantC, variantD])
  for (let t = 0; t < seconds; t += 0.1) step(app, 0.1)
  app.data = data
  app.variant = variant
  if (sel) app.sel[data] = sel
  return app
}

if (import.meta.main && process.argv[2] !== "interactions") {
  const cols = Number(process.argv[2] ?? 120)
  const rows = Number(process.argv[3] ?? 35)
  const secs = Number(process.argv[4] ?? 60)
  const only = process.argv[5]
  const border = `+${"-".repeat(cols)}+`
  for (const data of ["workflow", "swarm"] as const) {
    for (const v of [0, 1, 2, 3]) {
      if (only && only !== `${"abc"[v]}-${data}`) continue
      const app = scenario(secs, data, v, data === "workflow" ? "worker-1" : "coder-b")
      console.log(`\n=== Variant ${"ABCD"[v]} · ${data} · ${cols}x${rows} · t=${secs}s ===`)
      console.log(border)
      console.log(
        snap(app, cols, rows)
          .split("\n")
          .map((l) => `|${l}|`)
          .join("\n"),
      )
      console.log(border)
    }
  }
  void handleInput
  void key
}

/** A few interaction states, driven through the same key handling as the real app. */
export function interactions(): string {
  const out: string[] = []
  const show = (title: string, app: App, cols = 120, rows = 35) => {
    out.push(`\n=== ${title} · ${cols}x${rows} ===`, snap(app, cols, rows))
  }
  const press = (app: App, ...names: string[]) => {
    for (const n of names) handleInput(app, n.length === 1 ? { ...key(n), text: n } : key(n))
  }
  let app = scenario(60, "workflow", 0, "worker-1")
  press(app, "o")
  show("Variant A · o (diff overlay) on worker-1", app)
  app = scenario(60, "workflow", 2, "worker-1")
  press(app, "enter", "tab", "tab")
  show("Variant C · Enter (detail overlay) + Tab to Logs", app)
  app = scenario(60, "workflow", 3, "worker-1")
  press(app, "enter")
  show("Variant D · Enter (full-screen page) on worker-1", app)
  press(app, "right", "right")
  show("Variant D · page, → → to Logs", app)
  app = scenario(130, "workflow", 1, "worker-1")
  press(app, "r")
  for (const ch of "keep the old cookie name for one release") press(app, ch)
  show("Variant B · r (request changes) while typing, worker-1 waiting for approval", app)
  press(app, "enter", "a")
  for (let t = 0; t < 8; t += 0.1) step(app, 0.1)
  press(app, "tab", "tab")
  show("Variant B · after Enter + a (approve), Logs tab, 8 s later", app)
  return out.join("\n")
}

if (import.meta.main && process.argv[2] === "interactions") console.log(interactions())
