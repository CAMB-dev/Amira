// PROTOTYPE — not production. Throwaway; delete once the real design is decided.
//
// Question it answers: what should Amira's orchestration dashboard (the full-screen panel for
// dynamic workflows and swarms) look and feel like in a real terminal?
//
// Run:   bun packages/tui/prototypes/orchestration-dashboard.prototype.ts
//        (or: cd packages/tui && bun run prototype:dashboard)
// Snaps: bun packages/tui/prototypes/orchestration-dashboard/snapshots.ts
//
// Three radically different layouts over the same fake, simulated data (a workflow and a swarm):
//   F1 / A  timeline + detail panel (faithful to the mockup)
//   F2 / B  two-pane navigator (tree left, focused detail right)
//   F3 / C  lanes board (cards move between phase lanes; swarm = a column per member)
//   F4 / D  timeline like A, with more room (fewer details per line, blank lines between phases)
// Keys: [ ] or F1-F4 variant · d data set · space pause · +/- speed · ↑↓←→ move · Enter open ·
//       Tab/Shift+Tab detail tab · o diff · p pause agent · r request changes · a/x approve/deny ·
//       i or / type to the commander (@name for a member) · Esc back · PgUp/PgDn, wheel scroll · q quit
import { FullScreenRenderer, InputReader, modes, ProcessTerminal, setupTerminalInput } from "@amira/tui-kit"
import { createApp, handleInput, rootComponent, step } from "./orchestration-dashboard/app.ts"
import { variantA } from "./orchestration-dashboard/variant-a.ts"
import { variantB } from "./orchestration-dashboard/variant-b.ts"
import { variantC } from "./orchestration-dashboard/variant-c.ts"
import { variantD } from "./orchestration-dashboard/variant-d.ts"

if (!process.stdin.isTTY) {
  console.error("This prototype needs an interactive terminal.")
  process.exit(1)
}

const terminal = new ProcessTerminal()
const { capabilities, leftoverInput } = await setupTerminalInput(terminal)
terminal.enableMode(modes.mouse)

let timer: ReturnType<typeof setInterval> | undefined
let reader: InputReader | undefined
let renderer: FullScreenRenderer | undefined

function quit() {
  clearInterval(timer)
  reader?.stop()
  renderer?.close()
  terminal.stop()
  process.exit(0)
}

const app = createApp([variantA, variantB, variantC, variantD], quit)
renderer = new FullScreenRenderer(terminal, rootComponent(app), {
  synchronizedOutput: capabilities.synchronizedOutput,
})
renderer.open()

reader = new InputReader(terminal, (e) => {
  handleInput(app, e)
  renderer!.requestRender()
})
reader.start()
if (leftoverInput) reader.feed(leftoverInput)

const TICK = 0.1
timer = setInterval(() => {
  step(app, TICK)
  renderer!.requestRender()
}, TICK * 1000)
