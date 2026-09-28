// Manual demo: bun packages/tui-kit/examples/demo.ts
import {
  Editor,
  type InputEvent,
  InputReader,
  LiveRenderer,
  matchesKey,
  ProcessTerminal,
  Spinner,
  Stack,
  setupTerminalInput,
  Text,
  defaultTheme as theme,
} from "../src/index.ts"

if (!process.stdin.isTTY) {
  console.error("demo needs an interactive terminal")
  process.exit(1)
}

const REPLY =
  "This is a streamed reply. It grows word by word in the live region at the bottom, " +
  "wrapping by display width — 中文也可以正常换行，emoji too 🎉. When it finishes, it is committed " +
  "above and scrolls into the scrollback like normal output."

const terminal = new ProcessTerminal()
terminal.start()
const { capabilities, leftoverInput } = await setupTerminalInput(terminal)

const stream = new Text()
const spinner = new Spinner({ label: "Streaming… (Esc to stop)" })
const editor = new Editor({ prompt: "> ", placeholder: "Type a message", onSubmit: submit })
const status = new Text()
const root = new Stack([stream, editor, status])
const renderer = new LiveRenderer(terminal, root, { synchronizedOutput: capabilities.synchronizedOutput })

const modes = [
  capabilities.win32InputMode && "win32-input",
  capabilities.kittyKeyboard && "kitty",
  capabilities.synchronizedOutput && "sync",
].filter(Boolean)
const newlineHint = capabilities.shiftEnter ? "Shift+Enter" : "Ctrl+Enter"
status.setText(
  theme.muted(`Enter send · ${newlineHint} newline · Ctrl+C quit · ${modes.join(", ") || "legacy input"}`),
)

let streaming: ReturnType<typeof setInterval> | undefined

function submit(text: string) {
  if (text.trim() === "") return
  renderer.commit(text.split("\n").map((l, i) => theme.accent(i === 0 ? "> " : "  ") + l))
  startStream()
}

function startStream() {
  const words = REPLY.split(" ")
  let i = 0
  root.add(spinner, 1)
  spinner.start(() => renderer.requestRender())
  streaming = setInterval(() => {
    stream.append((i === 0 ? "" : " ") + words[i])
    i++
    renderer.requestRender()
    if (i >= words.length) finishStream()
  }, 60)
}

function finishStream() {
  clearInterval(streaming)
  streaming = undefined
  spinner.stop()
  root.remove(spinner)
  const text = stream.getText()
  stream.setText("")
  renderer.commit([text, ""])
}

function onInput(e: InputEvent) {
  if (matchesKey(e, "c", { ctrl: true }) || matchesKey(e, "d", { ctrl: true })) return quit()
  if (streaming && matchesKey(e, "escape")) return finishStream()
  if (editor.handleInput(e)) renderer.requestRender()
}

function quit() {
  clearInterval(streaming)
  spinner.stop()
  reader.stop()
  renderer.stop()
  terminal.stop()
  process.exit(0)
}

const reader = new InputReader(terminal, onInput)
reader.start()
renderer.start()
if (leftoverInput) reader.feed(leftoverInput)
