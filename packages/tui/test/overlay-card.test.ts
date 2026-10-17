import { expect, test } from "bun:test"
import type { FormValues, TuiSettings } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { CURSOR_MARKER, FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { OverlayManager } from "../src/app/overlays.ts"
import { pointerGeometry } from "../src/app/pointer.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import { contentGeometry } from "../src/margins.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import type { TranscriptView } from "../src/view.ts"
import { setup as setupApp, waitFor } from "./app-harness.ts"

function setup({
  columns = 100,
  rows = 30,
  card = true,
  header = "",
  settings = { margin: 0, marginRows: 0 },
}: {
  columns?: number
  rows?: number
  card?: boolean
  header?: string
  settings?: TuiSettings
} = {}) {
  const terminal = new FakeTerminal(columns, rows)
  const screen = new VirtualScreen(columns, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const dimmed: string[] = []
  let cardRow = 10
  const view = createFullscreenView({
    terminal,
    theme: {
      ...plain.theme,
      dim: (text) => {
        dimmed.push(text)
        return text
      },
    },
    capabilities: {
      win32InputMode: false,
      kittyKeyboard: true,
      synchronizedOutput: false,
      shiftEnter: true,
    },
    settings,
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: defaultKeybindings(),
    spinner: new Spinner(),
    sessionId: () => "session",
    detail: () => "summary",
    header: () => (header ? [header] : []),
    bottom: () => [`draft${CURSOR_MARKER}`],
    overlay: {
      render: (width, ctx) => {
        const output = Array<string>(ctx.rows).fill("")
        const cardWidth = Math.min(width - 8, 88)
        const left = Math.floor((width - cardWidth) / 2)
        output[cardRow] = " ".repeat(left) + "card".padEnd(cardWidth, ".")
        return output
      },
    },
    overlayCard: () => card,
    editorEmpty: () => false,
    showNote: () => {},
  })
  view.dialogEcho(() =>
    Array.from({ length: rows - 4 }, (_, i) => `${i}: ${"transcript ".repeat(12)}`.slice(0, columns)),
  )
  view.start()
  return { view, screen, dimmed, moveCard: (row: number) => (cardRow = row) }
}

test("card preserves the last transcript frame above, below and on both sides, without its caret", () => {
  const { view, screen, dimmed, moveCard } = setup()
  try {
    const before = [...screen.lines]
    expect(screen.cursorVisible).toBe(true)
    expect(before[10]!.length).toBe(100)
    view.openOverlay()
    view.renderOverlay()
    const expected = [...before]
    expected[10] = `${before[10]!.slice(0, 6)}${"card".padEnd(88, ".")}${before[10]!.slice(94)}`
    expect(screen.lines).toEqual(expected)
    expect(screen.cursorVisible).toBe(false)
    expect(before[9]).toContain("transcript")
    expect(dimmed).toContain(before[9]!)
    expect(dimmed.every((line) => !line.includes(CURSOR_MARKER))).toBe(true)

    // Transcript events and repeated overlay frames must not refresh the frozen backdrop.
    view.dialogEcho(() => ["arrived while covered"])
    view.renderOverlay()
    expect(screen.lines).toEqual(expected)
    moveCard(11)
    view.renderOverlay()
    expect(screen.lines[10]).toBe(before[10])
    expect(screen.lines[11]).toBe(
      `${before[11]!.slice(0, 6)}${"card".padEnd(88, ".")}${before[11]!.slice(94)}`,
    )
    view.closeOverlay()
    expect(screen.lines.join("\n")).toContain("arrived while covered")
    expect(screen.cursorVisible).toBe(true)
  } finally {
    view.stop()
  }
})

for (const settings of [{}, { margin: 6, marginRows: 3 }]) {
  test(`card bypasses transcript margins without moving its frozen backdrop: ${JSON.stringify(settings)}`, () => {
    const { view, screen } = setup({ columns: 80, rows: 24, settings })
    try {
      const before = [...screen.lines]
      view.openOverlay()
      view.renderOverlay()
      const expected = [...before]
      expected[10] = `${before[10]!.slice(0, 4)}${"card".padEnd(72, ".")}${before[10]!.slice(76)}`
      expect(screen.lines).toEqual(expected)
      view.closeOverlay()
      expect(screen.lines).toEqual(before)
    } finally {
      view.stop()
    }
  })
}

for (const [columns, rows] of [
  [80, 24],
  [60, 20],
  [62, 20],
] as const) {
  for (const settings of [{}, { margin: 6, marginRows: 3 }]) {
    test(`real card frame and SGR mouse use terminal coordinates at ${columns}x${rows}: ${JSON.stringify(settings)}`, async () => {
      const app = await setupApp([], { cols: columns, rows, settings })
      let saved: FormValues | undefined
      const result = app.host.ui
        .api("test")
        .form({
          title: "Terminal card",
          layout: "card",
          fields: [
            { id: "first", type: "text", label: "First", default: "one" },
            { id: "second", type: "text", label: "Second", default: "two" },
            ...Array.from({ length: 24 }, (_, i) => ({
              id: `field${i}`,
              type: "text" as const,
              label: `Field ${i}`,
            })),
          ],
        })
        .then((values) => {
          saved = values
        })
      const click = (text: string) => {
        const y = app.screen.lines.findIndex((line) => line.includes(text))
        expect(y).toBeGreaterThanOrEqual(0)
        const x = app.screen.lines[y]!.indexOf(text)
        app.terminal.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
      }
      try {
        await waitFor(() => app.live().includes("Terminal card"), "terminal card")
        const frame = [...app.screen.lines]
        const width = Math.min(columns - 8, 88)
        const left = Math.floor((columns - width) / 2)
        const top = frame.findIndex((line) => line[left] === "╭" && line.includes("Terminal card"))
        const bottom = frame.findIndex((line) => line[left] === "╰")
        expect(top).toBe(2)
        expect(bottom).toBe(rows - 3)
        expect(bottom - top + 1).toBe(rows - 4)
        expect(frame[top]!.indexOf("╭")).toBe(left)
        expect(frame[top]!.indexOf("╮")).toBe(left + width - 1)
        for (const line of frame.slice(top + 1, bottom)) {
          expect(line[left]).toBe("│")
          expect(line[left + width - 1]).toBe("│")
        }
        expect(frame[bottom]!.lastIndexOf("╰")).toBe(left)
        expect(frame[bottom]!.indexOf("╯")).toBe(left + width - 1)

        click("Second")
        app.terminal.send("\x1b[F!")
        await waitFor(() => app.live().includes("two!"), "terminal-relative field click")
        click("Save")
        await waitFor(() => saved !== undefined, "terminal-relative Save click")
        expect(saved).toMatchObject({ first: "one", second: "two!" })
      } finally {
        app.terminal.send("\x1b[27u\x03\x03")
        await result
        await app.exited
      }
    })
  }
}

test("card cell boundaries blank partial wide graphemes instead of shifting the card or suffix", () => {
  const { view, screen, moveCard } = setup({ header: `abcde界${"m".repeat(86)}界TAIL` })
  try {
    moveCard(0)
    view.openOverlay()
    view.renderOverlay()
    expect(screen.lines[0]).toBe(`abcde ${"card".padEnd(88, ".")} TAIL`)
  } finally {
    view.stop()
  }
})

for (const options of [{ card: false }, { columns: 59 }, { rows: 19 }]) {
  test(`plain overlay is unchanged without card geometry: ${JSON.stringify(options)}`, () => {
    const { view, screen, dimmed } = setup(options)
    try {
      dimmed.length = 0
      view.openOverlay()
      view.renderOverlay()
      expect(screen.lines[0]).toBe("")
      expect(screen.lines.at(-1)).toBe("")
      expect(screen.lines[10]).toContain("card")
      expect(screen.lines.join("\n")).not.toContain("transcript")
      expect(dimmed).toEqual([])
    } finally {
      view.stop()
    }
  })
}

function managerSetup(card: boolean) {
  const ui = new UiRequests(new EventBus())
  const view = {
    openOverlay: () => {},
    closeOverlay: () => {},
    renderOverlay: () => {},
    requestOverlayRender: () => {},
  } as TranscriptView
  let chromeCalls = 0
  const manager = new OverlayManager({
    ui,
    keys: defaultKeybindings(),
    theme: plain.theme,
    env: {},
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
    renderInput: () => [],
    conversationChrome: () => {
      chromeCalls++
      return ["conversation chrome"]
    },
    pointerHint: () => "pointer hint",
  })
  manager.onUiRequest({
    requestId: "provider",
    kind: "form",
    title: "Provider setup",
    ...(card ? { layout: "card" } : {}),
    fields: [{ type: "text", id: "key", label: "API key" }],
  })
  return { manager, chromeCalls: () => chromeCalls }
}

test("card gets the full overlay height without conversation chrome or pointer hint reservation", () => {
  const { manager, chromeCalls } = managerSetup(true)
  try {
    const ctx = { ...plain, rows: 24 }
    expect(manager.overlayCard(80, ctx)).toBe(true)
    expect(pointerGeometry({ columns: 80, rows: 24 }, { margin: 6, marginRows: 3 }, manager)).toEqual({
      left: 0,
      width: 80,
      rows: 0,
      height: 24,
    })
    const rows = manager.render(80, ctx)
    expect(rows).toHaveLength(24)
    expect(rows.join("\n")).toContain("Provider setup")
    expect(rows.join("\n")).not.toContain("conversation chrome")
    expect(rows.join("\n")).not.toContain("pointer hint")
    expect(chromeCalls()).toBe(0)
  } finally {
    manager.dispose()
  }
})

for (const [card, width, height] of [
  [false, 80, 24],
  [true, 59, 24],
  [true, 80, 19],
] as const) {
  test(`plain/fallback form retains chrome reservation: card=${card}, ${width}x${height}`, () => {
    const { manager, chromeCalls } = managerSetup(card)
    try {
      const ctx = { ...plain, rows: height }
      expect(manager.overlayCard(width, ctx)).toBe(false)
      const settings = { margin: 6, marginRows: 3 }
      expect(pointerGeometry({ columns: width, rows: height }, settings, manager)).toEqual(
        contentGeometry(width, height, settings),
      )
      const rows = manager.render(width, ctx)
      expect(rows).toHaveLength(height)
      expect(rows.slice(-2)).toEqual(["conversation chrome", "pointer hint"])
      expect(chromeCalls()).toBe(1)
    } finally {
      manager.dispose()
    }
  })
}
