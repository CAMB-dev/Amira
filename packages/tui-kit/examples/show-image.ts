// Manual check: bun packages/tui-kit/examples/show-image.ts <file or http(s) URL> [--protocol sixel|kitty|iterm2]
//
// Probes the terminal the way Amira does, prints what it found, then draws the image through the
// same path a reply takes (the live renderer committing an image line between two text lines):
// "after the image" must follow the image directly, with no gap and no overlap.
import { remoteImageFetch } from "../../tui/src/images.ts"
import {
  chooseImageSupport,
  ImageLoader,
  type ImageProtocol,
  LiveRenderer,
  ProcessTerminal,
  pendingImage,
  setupTerminalInput,
} from "../src/index.ts"

const args = process.argv.slice(2)
const at = args.indexOf("--protocol")
const forced = at >= 0 ? (args.splice(at, 2)[1] as ImageProtocol | undefined) : undefined
const src = args[0]
if (!src || (forced && !["sixel", "kitty", "iterm2"].includes(forced))) {
  console.error(
    "usage: bun packages/tui-kit/examples/show-image.ts <file or URL> [--protocol sixel|kitty|iterm2]",
  )
  process.exit(2)
}
if (!process.stdin.isTTY) {
  console.error("show-image needs an interactive terminal")
  process.exit(1)
}

const terminal = new ProcessTerminal()
terminal.start()
const { capabilities } = await setupTerminalInput(terminal, process.env, { images: true })
const g = capabilities.graphics
const auto = chooseImageSupport("auto", g, process.env)
const support = forced
  ? { protocol: forced, cell: chooseImageSupport("on", g, process.env)!.cell }
  : (auto ?? chooseImageSupport("on", g, process.env)!)

const info = [
  `terminal: ${process.env.WT_SESSION ? "Windows Terminal " : ""}TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "-"} TERM=${process.env.TERM ?? "-"}`,
  `probe: answered=${g?.answered} sixel(DA1 4)=${g?.sixel} kitty=${g?.kitty} cell=${g?.cell ? `${g.cell.width}x${g.cell.height}` : "none"}`,
  `tui.images "auto" would ${auto ? `use ${auto.protocol}` : "show alt text only"}; drawing with ${support.protocol}, cell ${support.cell.width}x${support.cell.height}${forced ? " (forced)" : auto ? "" : ' (as "on" would)'}`,
]

const loader = new ImageLoader({
  support,
  cwd: process.cwd(),
  fetchRemote: remoteImageFetch(),
  maxRows: () => Math.max(1, Math.min(20, Math.floor(terminal.rows * 0.4))),
})
const maxCols = terminal.columns - 2
const started = performance.now()
const load = loader.load(src, maxCols)
const renderer = new LiveRenderer(terminal, { render: () => ["(loading…)"] })
renderer.start()
renderer.commit([
  ...info,
  "before the image",
  `  ${pendingImage(load, [`🖼\uFE0F ${src}`], 10_000)}`,
  "after the image",
])
const block = await load
await Bun.sleep(50)
renderer.stop({ clear: true })
terminal.stop()
console.log(
  block
    ? `drawn: ${block.cols} columns × ${block.rows} rows, ${block.seq.length} bytes of ${support.protocol}, in ${Math.round(performance.now() - started)} ms`
    : "not drawn: the file is missing, too large, not a PNG/JPEG/GIF (or WebP with iTerm2), or the download failed",
)
