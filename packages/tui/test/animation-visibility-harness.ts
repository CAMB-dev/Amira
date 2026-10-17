import { jest } from "bun:test"
import type { ViewDefinition } from "@amira/api"
import { FakeTerminal, FullScreenRenderer, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

/** Count callbacks as well as live intervals: a renderer can suppress writes but still wake. */
export function animationProbe() {
  const active = new Set<unknown>()
  let wakes = 0
  const schedule = globalThis.setInterval
  const cancel = globalThis.clearInterval
  const start = jest
    .spyOn(globalThis, "setInterval")
    .mockImplementation((...args: Parameters<typeof setInterval>) => {
      const [callback, delay, ...params] = args
      const timer = schedule(() => {
        wakes++
        callback(...params)
      }, delay)
      active.add(timer)
      return timer
    })
  const stop = jest.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
    active.delete(timer)
    Reflect.apply(cancel, globalThis, [timer])
  })
  const fullscreen = jest.spyOn(FullScreenRenderer.prototype, "requestRender")
  return {
    sample: () => ({
      intervals: active.size,
      wakes,
      requests: fullscreen.mock.calls.length,
    }),
    restore: () => {
      start.mockRestore()
      stop.mockRestore()
      fullscreen.mockRestore()
    },
  }
}

/** Real transcript renderers and overlay scheduler, with no process terminal or user files. */
export function visibilityHarness(_mode: "fullscreen", definition: ViewDefinition) {
  const terminal = new FakeTerminal(80, 24)
  const screen = new VirtualScreen(80, 24)
  const write = terminal.write.bind(terminal)
  let writes = 0
  terminal.write = (data) => {
    writes++
    write(data)
    screen.write(data)
  }
  const keys = defaultKeybindings()
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
    keys,
    spinner: new Spinner(),
    sessionId: () => "main",
    detail: () => "summary",
    bottom: (width, ctx, budget) => [...manager.renderDock(width, ctx, Math.max(0, budget - 1)), "input"],
    overlay: { render: (width, ctx) => manager.render(width, ctx) },
    editorEmpty: () => true,
    showNote: () => {},
  })
  const manager = new OverlayManager({
    keys,
    theme: plain.theme,
    env: {},
    views: { get: () => definition },
    reaches: () => true,
    view: () => view,
    emitWaiting: () => {},
    working: () => false,
    interrupt: () => {},
    quitting: () => false,
    editorEmpty: () => true,
    searchActive: () => false,
    searchHint: () => undefined,
    inputFocused: () => {},
    renderInput: () => ["input"],
  })
  view.start()
  return {
    view,
    manager,
    screen: () => screen.lines.join("\n"),
    writes: () => writes,
    dispose: () => {
      manager.dispose()
      view.stop()
    },
  }
}
