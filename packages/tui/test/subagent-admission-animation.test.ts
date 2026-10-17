import { expect, test } from "bun:test"
import { type AnyEvent, type EventMap, emptyUsage } from "@amira/api"
import { EventBus } from "@amira/core"
import { FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: admission restarts animation after the last working child and parent ended`, async () => {
    const terminal = new FakeTerminal(100, 32)
    const screen = new VirtualScreen(100, 32)
    const write = terminal.write.bind(terminal)
    terminal.write = (data) => {
      write(data)
      screen.write(data)
    }
    const spinner = new Spinner()
    const view = createFullscreenView({
      terminal,
      theme: plain.theme,
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      settings: { margin: 0, marginRows: 0 },
      presenters: undefined,
      hyperlinks: false,
      renders: new ReplyRenderers(undefined),
      keys: new Keybindings(defaultKeys({ vscode: false })),
      spinner,
      sessionId: () => "main",
      detail: () => "summary",
      bottom: () => ["input"],
      overlay: { render: () => [] },
      editorEmpty: () => true,
      showNote: () => {},
    })
    const bus = new EventBus()
    const emit = <K extends keyof EventMap>(type: K, data: EventMap[K], sessionId = "main") =>
      view.subagentEvent(bus.emit(type, data, { sessionId }) as AnyEvent)
    const start = (id: string, queued: boolean) =>
      emit("subagent.start", {
        childSessionId: id,
        title: id,
        prompt: "work",
        model: { provider: "mock", model: "m1" },
        depth: 1,
        cwd: "/work",
        context: "fresh",
        queued,
      })
    view.start()
    try {
      start("First child", false)
      start("Queued child", true)
      emit("subagent.end", {
        childSessionId: "First child",
        status: "done",
        usage: emptyUsage(),
        durationMs: 0,
      })
      const stopped = spinner.glyph
      await Bun.sleep(Spinner.INTERVAL_MS * 2)
      expect(spinner.glyph).toBe(stopped)
      expect(spinner.running).toBe(false)
      emit(
        "session.start",
        { reason: "startup", cwd: "/work", model: { provider: "mock", model: "m1" } },
        "Queued child",
      )
      await Bun.sleep(Spinner.INTERVAL_MS * 3)
      view.render()
      expect(spinner.glyph).not.toBe(stopped)
      expect(screen.lines.join("\n")).toContain(`${spinner.glyph} working Queued child`)
    } finally {
      view.stop()
    }
  })
}
