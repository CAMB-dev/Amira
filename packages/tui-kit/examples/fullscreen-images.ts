// Manual check: bun packages/tui-kit/examples/fullscreen-images.ts [image files or URLs…] [--protocol sixel|kitty|iterm2]
//
// A full-screen transcript like Amira's (the same pane, reply blocks and renderer) holding a few
// replies with images: three generated ones, and any given. Scroll it and watch the images move,
// get cut at the edges (Sixel, kitty) or turn into "🖼 alt (scroll to view)" (iTerm2), and leave
// no pixels behind. The last line says what the last frame cost.
//
//   ↑ ↓ / wheel / PgUp PgDn / Home End   scroll        Ctrl+↑  select a block (↑ ↓ move, Enter fold, Esc back)
//   o   an overlay over everything       r  redraw     q / Ctrl+C  quit (prints the transcript as text)
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encode as encodePng } from "fast-png"
import { type BlockEnv, type BlockImages, LinesBlock, ReplyBlock } from "../../tui/src/blocks.ts"
import { remoteImageFetch } from "../../tui/src/images.ts"
import { TranscriptPane } from "../../tui/src/transcript-pane.ts"
import {
  type Component,
  chooseImageSupport,
  FullScreenRenderer,
  ImageLoader,
  type ImageProtocol,
  type InputEvent,
  InputReader,
  matchesKey,
  modes,
  ProcessTerminal,
  type RenderContext,
  setupTerminalInput,
  defaultTheme as theme,
  truncateToWidth,
} from "../src/index.ts"

const args = process.argv.slice(2)
const at = args.indexOf("--protocol")
const forced = at >= 0 ? (args.splice(at, 2)[1] as ImageProtocol | undefined) : undefined
if (forced && !["sixel", "kitty", "iterm2"].includes(forced)) {
  console.error(
    "usage: bun packages/tui-kit/examples/fullscreen-images.ts [images…] [--protocol sixel|kitty|iterm2]",
  )
  process.exit(2)
}
if (!process.stdin.isTTY) {
  console.error("fullscreen-images needs an interactive terminal")
  process.exit(1)
}

/** Three test images: a wide gradient, a tall checkerboard, and a many-colored "photo". */
function generated(): { name: string; path: string }[] {
  const dir = mkdtempSync(join(tmpdir(), "amira-fs-images-"))
  const make = (name: string, width: number, height: number, px: (x: number, y: number) => number[]) => {
    const data = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) data.set([...px(x, y), 255], (y * width + x) * 4)
    const path = join(dir, `${name}.png`)
    writeFileSync(path, encodePng({ width, height, data, channels: 4 }))
    return { name, path }
  }
  return [
    make("gradient", 600, 200, (x, y) => [Math.round((x / 600) * 255), Math.round((y / 200) * 255), 160]),
    make("checkerboard", 240, 400, (x, y) => (((x >> 5) + (y >> 5)) % 2 ? [240, 240, 240] : [30, 90, 200])),
    make("photo", 640, 480, (x, y) => {
      const d = Math.hypot(x - 320, y - 240) / 400
      return [
        Math.round(128 + 127 * Math.sin(x / 40 + d * 6)),
        Math.round(128 + 127 * Math.sin(y / 30 - d * 4)),
        Math.round(255 * (1 - d)),
      ]
    }),
  ]
}

const terminal = new ProcessTerminal()
terminal.start()
const { capabilities, leftoverInput } = await setupTerminalInput(terminal, process.env, { images: true })
const g = capabilities.graphics
const auto = chooseImageSupport("auto", g, process.env)
const support = forced
  ? { protocol: forced, cell: chooseImageSupport("on", g, process.env)!.cell }
  : (auto ?? chooseImageSupport("on", g, process.env)!)

const loader = new ImageLoader({
  support,
  cwd: process.cwd(),
  fetchRemote: remoteImageFetch(),
  maxRows: () => Math.max(1, Math.min(20, Math.floor(terminal.rows * 0.4))),
})

const pane = new TranscriptPane()
const images: BlockImages = { loader, changed: () => renderer.requestRender() }
const filler = (n: number, what: string) =>
  Array.from({ length: n }, (_, i) => `${what} line ${i + 1}: some text to scroll past.`).join("\n")
const sources = [...generated(), ...args.map((a) => ({ name: a, path: a }))]
pane.add(
  new LinesBlock("banner", () => [
    theme.accent(
      `Full-screen images · ${support.protocol} · cell ${support.cell.width}×${support.cell.height}`,
    ),
  ]),
)
sources.forEach((s, i) => {
  pane.add(new LinesBlock("user", () => [theme.accent(`› show me image ${i + 1}`)]))
  const text = `Here is **${s.name}**:\n\n![${s.name}](${s.path.replaceAll("\\", "/")})\n\n${filler(6, s.name)}`
  pane.add(new ReplyBlock(text, false, true))
})

let overlay = false
const stats = { layoutMs: 0, bytes: 0, sixel: 0, kitty: 0, iterm2: 0 }
const env = (width: number): BlockEnv => ({
  theme,
  width,
  now: Date.now(),
  spinner: "",
  detail: "full",
  presenters: undefined,
  hyperlinks: true,
  nodes: new Map(),
  images,
})

const root: Component = {
  render(width: number, ctx: RenderContext): string[] {
    if (overlay) {
      const box = ["", "  An overlay covers the transcript: no image may show through.", "  o closes it."]
      return [...box, ...Array(Math.max(0, ctx.rows - box.length)).fill("")]
    }
    const started = performance.now()
    const rows = pane.render(env(width), Math.max(1, ctx.rows - 2))
    for (const p of pane.placements) ctx.place?.(p)
    stats.layoutMs = performance.now() - started
    const hint = pane.selected
      ? "↑ ↓ move · Enter fold · Esc back"
      : "↑ ↓ wheel PgUp PgDn Home End scroll · Ctrl+↑ select · o overlay · r redraw · q quit"
    const last = `last frame: layout ${stats.layoutMs.toFixed(2)} ms · wrote ${(stats.bytes / 1024).toFixed(1)} KB · images sent: sixel ${stats.sixel} kitty ${stats.kitty} iTerm2 ${stats.iterm2}`
    return [...rows, truncateToWidth(theme.muted(hint), width), truncateToWidth(theme.muted(last), width)]
  },
}

// What each frame writes, for the status line of the next one.
const write = terminal.write.bind(terminal)
terminal.write = (data: string) => {
  stats.bytes = data.length
  stats.sixel = data.split("\x1bP0;1;0q").length - 1
  stats.kitty = data.split("\x1b_Ga=p,").length - 1
  stats.iterm2 = data.split("\x1b]1337;File=").length - 1
  write(data)
}

const renderer = new FullScreenRenderer(terminal, root, {
  synchronizedOutput: capabilities.synchronizedOutput,
  theme,
})

function onInput(e: InputEvent) {
  if (matchesKey(e, "c", { ctrl: true }) || (e.type === "key" && e.text === "q")) return quit()
  if (e.type === "mouse") {
    if (e.action === "wheel") pane.scrollBy(e.button === "up" ? -3 : 3)
  } else if (e.type === "key" && e.text === "o") overlay = !overlay
  else if (e.type === "key" && e.text === "r") return renderer.redraw()
  else if (pane.selected) {
    const b = pane.selected
    if (matchesKey(e, "up")) pane.selectPrev()
    else if (matchesKey(e, "down")) pane.selectNext()
    else if (matchesKey(e, "enter") && b.foldable(env(terminal.columns))) {
      b.toggleFold(env(terminal.columns))
      pane.reveal(b)
    } else if (matchesKey(e, "escape")) pane.selected = undefined
  } else if (matchesKey(e, "up", { ctrl: true })) pane.selectPrev()
  else if (matchesKey(e, "up")) pane.scrollBy(-1)
  else if (matchesKey(e, "down")) pane.scrollBy(1)
  else if (matchesKey(e, "pageup")) pane.pageUp()
  else if (matchesKey(e, "pagedown")) pane.pageDown()
  else if (matchesKey(e, "home")) pane.toTop()
  else if (matchesKey(e, "end")) pane.follow()
  renderer.requestRender()
}

function quit() {
  reader.stop()
  terminal.disableMode(modes.mouse)
  renderer.close()
  const text = pane.printout(env(terminal.columns))
  terminal.stop()
  console.log(text.join("\n"))
  console.log(
    `\n(the transcript as exiting prints it: images as their alt text; drawn with ${support.protocol})`,
  )
  process.exit(0)
}

const reader = new InputReader(terminal, onInput)
reader.start()
renderer.open()
terminal.enableMode(modes.mouse)
if (leftoverInput) reader.feed(leftoverInput)
