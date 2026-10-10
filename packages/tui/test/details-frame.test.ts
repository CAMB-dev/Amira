import { expect, test } from "bun:test"
import { textResult } from "@amira/api"
import { Editor, FakeTerminal, key, Spinner, visibleWidth } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { localClock, rememberMessageTime } from "../src/format.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { headerLine } from "../src/header.ts"
import { InputBox } from "../src/input-box.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import { withSnapshotClock } from "./clock-fixture.ts"

const at = new Date(2026, 9, 10, 20, 9).getTime()

test(
  "width-100 fullscreen details frames: verb groups and sticky prompt while scrolled",
  withSnapshotClock(() => {
    const terminal = new FakeTerminal(100, 18)
    const screen = new VirtualScreen(100, 18)
    const write = terminal.write.bind(terminal)
    terminal.write = (data) => {
      write(data)
      screen.write(data)
    }
    const box = new InputBox(new Editor({ prompt: "› ", placeholder: "Message Amira" }), () => [
      { id: "model", text: "mock/m1 · ask", align: "right", tone: "accent", priority: 40 },
    ])
    const view = createFullscreenView({
      terminal,
      theme: plain.theme,
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      settings: {},
      presenters: { get: (name) => builtinPresenters[name] },
      hyperlinks: false,
      renders: new ReplyRenderers(undefined),
      keys: new Keybindings(defaultKeys({ vscode: false })),
      spinner: new Spinner(),
      sessionId: () => "frame",
      detail: () => "summary",
      header: (width, ctx) => [
        headerLine(
          {
            cwd: "~/dev/Amira",
            branch: "details",
            title: "Transcript polish",
            cost: "$0.42",
            used: 124000,
            limit: 200000,
          },
          width,
          ctx,
        ),
      ],
      bottom: (width, ctx) => [...box.render(width, ctx), " shift+tab mode  │  ctrl+o detail  │  ? keys"],
      overlay: { render: () => [] },
      editorEmpty: () => true,
      showNote: () => {},
    })
    view.start()
    try {
      const prompt = {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Polish the transcript details.\nKeep all output reachable." },
        ],
      }
      rememberMessageTime(prompt, at)
      view.user(prompt)
      view.replyDelta(Array.from({ length: 18 }, (_, i) => `Transcript detail ${i + 1}.`).join("\n\n"))
      view.replyEnd([])
      for (const [i, name, args] of [
        [1, "read", { path: "a.ts" }],
        [2, "read", { path: "b.ts" }],
        [3, "read", { path: "c.ts" }],
        [4, "grep", { pattern: "TODO" }],
        [5, "grep", { pattern: "FIXME" }],
        [6, "edit", { path: "a.ts" }],
        [7, "bash", { command: "bun test" }],
      ] as const) {
        view.toolStart(String(i), name, args, at)
        view.toolEnd(String(i), {
          result: textResult(name === "bash" ? "412 pass\n0 fail" : "done"),
          durationMs: 0,
        })
      }
      view.turnEnd()
      view.render()
      expect(screen.lines[1]).toBe(
        `  › Polish the transcript details.…${" ".repeat(63 - visibleWidth(localClock(at)))}${localClock(at)}`,
      )
      expect(screen.lines.join("\n")).toContain("Read 3 files")
      expect(screen.lines.join("\n")).toContain("Searched 2 patterns")
      expect(screen.lines.join("\n")).not.toContain("Explored")
      expect(screen.lines.every((row) => visibleWidth(row) <= 100)).toBe(true)
      expect(screen.lines.join("\n")).toMatchSnapshot("verb-grouped tree")
      view.handleInput(key("up", { shift: true }))
      view.handleInput(key("up", { shift: true }))
      view.render()
      expect(screen.lines[1]).toContain("Polish the transcript details.…")
      expect(screen.lines.join("\n")).toContain("2 rows below")
      expect(screen.lines.join("\n")).toMatchSnapshot("sticky while scrolled")
    } finally {
      view.stop()
    }
  }),
)
