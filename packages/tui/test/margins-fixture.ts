import { userMessage } from "@amira/ai"
import { type TuiSettings, textResult } from "@amira/api"
import { type Component, createTheme, Editor, FakeTerminal, Spinner } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { rememberMessageTime } from "../src/format.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { headerLine } from "../src/header.ts"
import { createInlineView } from "../src/inline-view.ts"
import { InputBox } from "../src/input-box.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import type { TranscriptView } from "../src/view.ts"
import { withSnapshotClock } from "./clock-fixture.ts"

export const zeroMargins = { margin: 0, marginRows: 0 }
const at = new Date(2026, 9, 10, 20, 9).getTime()

/** Real view/renderer writes, including the exit printout, with no asynchronous agent timing. */
export const marginFrame = withSnapshotClock(
  (
    fullscreen: boolean,
    columns: number,
    rows: number,
    settings: TuiSettings,
    options: {
      overlay?: Component
      bottom?: Component
      afterRender?: (view: TranscriptView, screen: VirtualScreen, terminal: FakeTerminal) => void
    } = {},
  ) => {
    const now = Date.now
    Date.now = () => at
    const terminal = new FakeTerminal(columns, rows)
    const screen = new VirtualScreen(columns, rows)
    const write = terminal.write.bind(terminal)
    terminal.write = (data) => {
      write(data)
      screen.write(data)
    }
    const editor = new Editor({ prompt: "› ", placeholder: "Message Amira" })
    editor.setText("Check the changes")
    const box = new InputBox(editor, () => [])
    const view = (fullscreen ? createFullscreenView : createInlineView)({
      terminal,
      theme: createTheme({ theme: "dark", colorDepth: "truecolor", color: true, platform: "linux" }),
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      settings,
      presenters: { get: (name) => builtinPresenters[name] },
      hyperlinks: false,
      renders: new ReplyRenderers(undefined),
      keys: new Keybindings(defaultKeys({ vscode: false })),
      spinner: new Spinner(),
      sessionId: () => "margin-frame",
      detail: () => "full",
      header: (width, ctx) => [headerLine({ cwd: "~/dev/Amira", title: "Margins" }, width, ctx)],
      bottom: (width, ctx) => (options.bottom ?? box).render(width, ctx),
      overlay: options.overlay ?? { render: () => [] },
      editorEmpty: () => false,
      showNote: () => {},
    })
    let stopped = false
    try {
      view.banner("Amira margin regression")
      view.start()
      const message = userMessage("Fix add and check the project.")
      rememberMessageTime(message, at)
      view.user(message)
      view.reasoningDelta("Check the operator.")
      view.replyDelta("Corrected function:\n\n```ts\nconst add = (a, b) => a + b\n```")
      view.replyEnd([])
      view.toolStart("edit", "edit", { path: "src/add.ts", old_string: "a - b", new_string: "a + b" }, at)
      view.toolEnd("edit", { result: textResult("Updated src/add.ts"), durationMs: 0 })
      view.toolStart("check", "bash", { command: "bun test" }, at)
      view.toolEnd("check", { result: textResult("12 pass\n0 fail"), durationMs: 0 })
      view.turnEnd()
      view.render()
      options.afterRender?.(view, screen, terminal)
      const live = {
        ansi: terminal.output,
        grid: screen.grid.map((row) => row.join("")),
        scrollback: [...screen.scrollback],
      }
      view.stop()
      stopped = true
      return {
        live,
        committed: {
          ansi: terminal.output,
          grid: screen.grid.map((row) => row.join("")),
          scrollback: [...screen.scrollback],
        },
      }
    } finally {
      if (!stopped) view.stop()
      Date.now = now
    }
  },
)
