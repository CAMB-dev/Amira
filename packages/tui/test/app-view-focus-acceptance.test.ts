import { expect, test } from "bun:test"
import type { UiContext } from "@amira/api"
import { defaultKeys, parseKeybindings } from "../src/keybindings.ts"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

const encodings = {
  legacy: "\x1b[17~",
  win32: "\x1b[117;0;0;1;0;1_",
  kitty: "\x1b[17;1~",
}

async function fixture(
  mode: "inline" | "fullscreen",
  options: { needsTab?: boolean; dock?: boolean; binding?: string } = {},
) {
  let context!: UiContext
  let activations = 0
  const bindings = options.binding
    ? parseKeybindings({ "view.focus": options.binding }, "test", defaultKeys({ vscode: false }))
    : undefined
  const s = await setup([], {
    rows: 32,
    settings: { mode },
    keybindings: bindings?.keys,
    extensions: [
      (api) => {
        api.registerView({
          kind: "acceptance-focus",
          title: () => "Acceptance focus",
          needsTab: options.needsTab,
          ui: (_data, ctx) => {
            context = ctx
            return {
              type: "column",
              children: [
                { size: 1, node: { type: "bar", left: [{ kind: "text", text: "Acceptance focus" }] } },
                {
                  node: {
                    type: "tree",
                    id: "tasks",
                    items: Array.from({ length: 40 }, (_, i) => ({
                      key: `${i}`,
                      row: [{ kind: "text", text: `Task ${i}` }],
                    })),
                  },
                },
              ],
            }
          },
          onEvent: (event) => {
            if (event.type === "activate") activations++
          },
        })
        api.registerCommand({
          name: "acceptance-focus",
          description: "Open focus regression fixture",
          run: (_args, ctx) =>
            void ctx.openView?.({
              kind: "acceptance-focus",
              ...(options.dock ? { placement: "dock", maxHeight: 8 } : {}),
            }),
        })
      },
    ],
  })
  s.terminal.send("/acceptance-focus\r")
  await waitFor(() => !!context, "acceptance view")
  // Inline frames can end above the viewport's last row; the hint is the last nonblank frame row.
  return {
    ...s,
    bindings,
    context: () => context,
    activations: () => activations,
    hint: () => s.screen.lines.findLast((line) => line.trim().length > 0) ?? "",
  }
}

async function close(s: Awaited<ReturnType<typeof fixture>>) {
  s.host.ui.cancelAll()
  s.terminal.send("\x03\x03")
  await closeImageApp(s)
}

for (const mode of ["inline", "fullscreen"] as const) {
  for (const needsTab of [false, true]) {
    for (const [encoding, bytes] of Object.entries(encodings)) {
      test(`finding 1: ${mode}, needsTab=${needsTab}, ${encoding} F6 round-trip preserves text`, async () => {
        const s = await fixture(mode, { needsTab })
        try {
          s.terminal.send(bytes)
          await Bun.sleep(80)
          expect(s.context().focused).toBe(false)
          expect(s.hint()).toContain(needsTab ? "f6 → view" : "tab → view")
          if (!needsTab) expect(s.hint()).not.toContain("f6")
          s.terminal.send("draft")
          await waitFor(() => s.live().includes("│›draft"), "draft")
          s.terminal.send(bytes)
          await waitFor(() => s.context().focused === true, "F6 to view with text")
          expect(s.hint()).toContain(needsTab ? "f6 → input" : "tab → input")
          s.terminal.send(bytes)
          await waitFor(() => s.context().focused === false, "F6 to composer")
          expect(s.live()).toContain("│›draft")
        } finally {
          await close(s)
        }
      })
    }
  }

  test(`${mode}: reserved Shift+Tab binding warns and never advertises an ignored focus toggle`, async () => {
    const s = await fixture(mode, { needsTab: true, binding: "shift+tab" })
    try {
      expect(s.bindings?.warnings).toEqual([
        'test: "view.focus": cannot use "shift+tab": Shift+Tab is reserved for permission mode and reverse view navigation',
      ])
      expect(s.hint()).toContain("f6 → input")
      expect(s.hint()).not.toContain("shift+tab → input")
      s.terminal.send(encodings.legacy)
      await waitFor(() => s.context().focused === false, "valid default focus binding retained")
      expect(s.hint()).toContain("f6 → view")
      s.terminal.send("draft\x1b[Z")
      await waitFor(() => s.agent.permissions.mode !== "auto", "Shift+Tab remains the mode key")
      expect(s.context().focused).toBe(false)
      s.terminal.send(encodings.legacy)
      await waitFor(() => s.context().focused === true, "F6 returns despite invalid configured binding")
      expect(s.live()).toContain("draft")
    } finally {
      await close(s)
    }
  })

  test(`finding 1: ${mode} view.focus remapping changes routing and needsTab hints`, async () => {
    const s = await fixture(mode, { needsTab: true, binding: "f7" })
    try {
      expect(s.bindings?.warnings).toEqual([])
      expect(s.hint()).toContain("f7 → input")
      s.terminal.send(encodings.legacy)
      await Bun.sleep(80)
      expect(s.context().focused).toBe(true)
      s.terminal.send("\x1b[18~")
      await waitFor(() => s.context().focused === false, "rebound focus")
      expect(s.hint()).toContain("f7 → view")
      s.terminal.send("draft\x1b[18~")
      await waitFor(() => s.context().focused === true, "rebound focus with draft")
    } finally {
      await close(s)
    }
  })

  for (const [encoding, bytes] of Object.entries({ kitty: "\x1b[9;5u", win32: "\x1b[9;0;9;1;8;1_" })) {
    test(`finding 1: ${mode} ${encoding} Ctrl+Tab remains an alias`, async () => {
      const s = await fixture(mode, { needsTab: true })
      try {
        s.terminal.send(bytes)
        await waitFor(() => s.context().focused === false, "alias to input")
        expect(s.hint()).toContain("f6 → view")
        s.terminal.send(`draft${bytes}`)
        await waitFor(() => s.context().focused === true, "alias with draft")
      } finally {
        await close(s)
      }
    })
  }

  test(`finding 1: ${mode} Shift+Tab stays mode-owned or view-owned, never host-focus-owned`, async () => {
    const s = await fixture(mode, { needsTab: true })
    try {
      s.terminal.send("\x1b[Z")
      await s.idle()
      expect(s.context().focused).toBe(true)
      expect(s.agent.permissions.mode).toBe("auto")
      s.terminal.send(encodings.legacy)
      await waitFor(() => s.context().focused === false, "F6 to input")
      s.terminal.send("\x1b[Z")
      await waitFor(() => s.agent.permissions.mode !== "auto", "global mode key")
      expect(s.context().focused).toBe(false)
    } finally {
      await close(s)
    }
  })

  for (const dock of [false, true]) {
    test(`finding 2: ${mode} ${dock ? "dock" : "view"}, Ctrl+R → Esc → z types into the composer`, async () => {
      const s = await fixture(mode, { dock })
      try {
        if (!dock) s.terminal.send("\t")
        s.terminal.send("\x12")
        await waitFor(() => s.live().includes("search history"), "history search")
        s.terminal.send("\x1b")
        await Bun.sleep(100)
        s.terminal.send("z")
        await Bun.sleep(80)
        expect(s.live()).toContain("│›z")
        expect(s.live()).not.toContain("search history")
        expect(s.context().focused).toBe(false)
        s.terminal.send("\x15\x12")
        await waitFor(() => s.live().includes("search history"), "search reopened")
        expect(s.hint()).toContain("esc cancel")
        expect(s.hint()).not.toContain("esc → view")
        s.terminal.send("\x1b")
        await waitFor(() => !s.live().includes("search history"), "search cancelled first")
        expect(s.context().focused).toBe(false)
        s.terminal.send("\x1b")
        await waitFor(() => s.context().focused === true, "second empty Esc to view")
        s.terminal.send("z")
        await waitFor(() => s.live().includes("│›z"), "unhandled printable after handoff")
      } finally {
        await close(s)
      }
    })
  }

  test(`finding 2: ${mode} F6 handoff cancels search and restores the draft`, async () => {
    const s = await fixture(mode)
    try {
      s.terminal.send("\tdraft\x12")
      await waitFor(() => s.live().includes("search history"), "history search")
      s.terminal.send(encodings.legacy)
      await waitFor(() => s.context().focused === true, "F6 handoff")
      s.terminal.send(encodings.legacy)
      await waitFor(() => s.context().focused === false, "F6 return")
      s.terminal.send("z")
      await waitFor(() => s.live().includes("│›draftz"), "draft restored without invisible search")
      expect(s.live()).not.toContain("search history")
    } finally {
      await close(s)
    }
  })

  for (const [encoding, escapeBytes] of Object.entries({ legacy: "\x1b", kitty: "\x1b[27u" })) {
    test(`finding 3: ${mode} ${encoding} empty Esc focuses selectable dock; Esc with text preserves it`, async () => {
      const s = await fixture(mode, { dock: true })
      try {
        expect(s.hint()).toContain("esc → view")
        s.terminal.send(escapeBytes)
        await Bun.sleep(100)
        expect(s.context().focused).toBe(true)
        expect(s.live()).toContain("Task 0")
        s.terminal.send("\x1b[B")
        await waitFor(() => s.context().state.selected.tasks === "1", "dock keyboard selection")
        s.terminal.send("\tdraft")
        await waitFor(() => s.live().includes("│›draft"), "dock draft")
        expect(s.hint()).toContain("esc close dock")
        s.terminal.send(escapeBytes)
        await waitFor(() => !s.live().includes("Task 1"), "nonempty input closes dock as before")
        expect(s.live()).toContain("│›draft")
      } finally {
        await close(s)
      }
    })
  }

  for (const initiallyFocused of [false, true]) {
    test(`finding 3 edge: ${mode} hidden dock cannot retain or acquire focus (initial=${initiallyFocused})`, async () => {
      const s = await fixture(mode, { dock: true })
      try {
        if (initiallyFocused) {
          s.terminal.send(encodings.legacy)
          await waitFor(() => s.context().focused === true, "dock initially focused")
        }
        const beforeResize = s.terminal.output.length
        s.screen.resize(60, 6)
        s.terminal.setSize(60, 6)
        await waitFor(
          () =>
            s.terminal.output.length > beforeResize &&
            s.live().includes("Message Amira") &&
            !s.live().includes("Task 0"),
          "dock has no visible allocation",
        )
        expect(s.screen.cursorVisible).toBe(true)
        s.terminal.send(encodings.legacy)
        await Bun.sleep(80)
        expect(s.screen.cursorVisible).toBe(true)
        s.terminal.send("\x1b[B\r")
        await s.idle()
        expect(s.activations()).toBe(0)
        expect(s.context().state.selected.tasks).toBe("0")
        s.terminal.send("\x1b")
        await Bun.sleep(100)
        expect(s.screen.cursorVisible).toBe(true)
        expect(s.activations()).toBe(0)
        s.terminal.send("z")
        await Bun.sleep(80)
        expect(s.screen.lines[s.screen.y]).toBe("› z")
      } finally {
        await close(s)
      }
    })
  }

  test(`finding 4: ${mode} visible dialog permits dock wheel only; clicks never take keyboard focus`, async () => {
    const s = await fixture(mode, { dock: true })
    let answer: Promise<boolean | undefined> | undefined
    try {
      answer = s.host.ui.api("approval").confirm("Dock confirmation", "Proceed?")
      await waitFor(() => s.live().includes("Dock confirmation"), "visible dialog")
      const row = s.screen.lines.findIndex((line) => line.includes("Task 0"))
      expect(row).toBeGreaterThan(0)
      s.terminal.send(`\x1b[<0;8;${row + 1}M\x1b[<0;8;${row + 1}m`)
      await Bun.sleep(80)
      expect(s.context().focused).toBe(false)
      expect(s.context().state.selected.tasks).toBe("0")
      expect(s.activations()).toBe(0)
      s.terminal.send(`\x1b[<65;8;${row + 1}M`)
      await waitFor(() => (s.context().state.scroll.tasks?.top ?? 0) > 0, "wheel still scrolls dock")
      expect(s.context().focused).toBe(false)
      s.terminal.send("\x1b[B\r")
      expect(await answer).toBe(true)
      expect(s.context().state.selected.tasks).toBe("0")
      expect(s.activations()).toBe(0)
    } finally {
      await close(s)
    }
  })
}
