// A/B/D deliberate UI oracles: shared two-cell grid, fill-only code, rounded dialogs, › and ·.
import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import type { CommandContext, ViewDefinition } from "@amira/api"
import { dockHeight, dockKeyHelp } from "../src/app/dock.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { setup, waitFor } from "./app-harness.ts"

const ESC = "\x1b[27u"

test("dock caps reserve the input, default to forty percent, and respect the five-row minimum", () => {
  expect(dockHeight(30, 30)).toBe(12)
  expect(dockHeight(10, 10)).toBe(5)
  expect(dockHeight(30, 3)).toBe(3)
  expect(dockHeight(30, 30, 1)).toBe(5)
  expect(dockHeight(30, 30, 8)).toBe(8)
  expect(dockHeight(30, 0)).toBe(0)
  expect(
    dockKeyHelp(new Keybindings(defaultKeys({ vscode: false }))).find((key) => key.keys === "esc")
      ?.description,
  ).toBe("Focus a selectable dock when the input is empty; otherwise close it")
})

test("dock key help follows rebound or unbound scroll actions", () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "scroll.page-up": ["ctrl+alt+p"],
    "scroll.page-down": ["ctrl+alt+n"],
    "scroll.bottom": ["ctrl+alt+b"],
  })
  expect(dockKeyHelp(keys).find((key) => key.description.startsWith("Scroll the dock"))?.keys).toBe(
    "ctrl+alt+p/ctrl+alt+n",
  )
  expect(dockKeyHelp(keys).find((key) => key.description === "Follow new dock output")?.keys).toBe(
    "ctrl+alt+b",
  )
  const unbound = new Keybindings({ ...defaultKeys({ vscode: false }), "scroll.bottom": [] })
  expect(dockKeyHelp(unbound).some((key) => key.description === "Follow new dock output")).toBe(false)
})

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: dock routes rebound page and follow keys, not literal End`, async () => {
    const data = { rows: Array.from({ length: 40 }, (_, i) => `KEYROW-${i}`) }
    const s = await setup([], {
      rows: 40,
      settings: { mode, margin: 3, marginRows: 1 },
      keybindings: new Keybindings({
        ...defaultKeys({ vscode: false }),
        "scroll.page-up": ["ctrl+alt+p"],
        "scroll.page-down": ["ctrl+alt+n"],
        "scroll.bottom": ["ctrl+alt+b"],
      }),
      extensions: [
        (api) => {
          api.registerView({
            kind: "dock",
            title: () => "Rebound dock",
            render: () => data.rows.map((text) => ({ kind: "text" as const, text })),
          })
          api.registerCommand({
            name: "dock",
            description: "open dock",
            echo: false,
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "dock", placement: "dock", maxHeight: 10 })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/dock\r")
      await waitFor(() => s.live().includes("KEYROW-39"), "rebound dock following")
      s.terminal.send("\x1b[112;7u")
      await waitFor(() => !s.live().includes("KEYROW-39"), "rebound page up")
      const before = s.screen.lines.filter((line) => line.includes("KEYROW-")).join("\n")
      s.terminal.send("draft\x1b[D")
      await waitFor(() => s.live().includes("draft"), "draft before literal End")
      s.terminal.send("\x1b[Fx")
      await waitFor(() => s.live().includes("draftx"), "literal End belongs to input")
      expect(s.screen.lines.filter((line) => line.includes("KEYROW-")).join("\n")).toBe(before)
      s.terminal.send("\x1b[110;7u")
      await waitFor(() => s.live().includes("KEYROW-39"), "rebound page down")
      s.terminal.send("\x1b[112;7u")
      await waitFor(() => !s.live().includes("KEYROW-39"), "pause follow again")
      s.terminal.send("\x1b[98;7u")
      await waitFor(() => s.live().includes("KEYROW-39"), "rebound follow")
      data.rows.push("KEYROW-40")
      s.terminal.send("!")
      await waitFor(() => s.live().includes("KEYROW-40"), "rebound follow tracks new output")
      expect(s.live()).toContain("draftx!")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: a bounded dock preserves a short transcript and uses actual wheel coordinates`, async () => {
    const data = { rows: Array.from({ length: 40 }, (_, i) => `HITROW-${i}`) }
    const s = await setup([], {
      cols: 80,
      rows: 40,
      history: [userMessage("Short main transcript")],
      settings: { mode, margin: 3, marginRows: 1 },
      extensions: [
        (api) => {
          api.registerView({
            kind: "dock",
            title: () => "Bounded dock",
            render: () => data.rows.map((text) => ({ kind: "text" as const, text })),
          })
          api.registerCommand({
            name: "dock",
            description: "open dock",
            echo: false,
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "dock", placement: "dock", maxHeight: 10 })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/dock\r")
      await waitFor(() => s.live().includes("HITROW-39"), "bounded dock open")
      expect(s.live()).toContain("Short main transcript")
      const title = s.screen.lines.findIndex((line) => line.includes("Bounded dock"))
      const input = s.screen.lines.findIndex((line) => line.includes("╭"))
      expect(input - title).toBe(10)

      const wheel = (x: number, row: number) => s.terminal.send(`\x1b[<64;${x + 1};${row + 1}M`)
      const last = s.screen.lines.findIndex((line) => line.includes("HITROW-39"))
      const transcript = s.screen.lines.findIndex((line) => line.includes("Short main transcript"))
      wheel(1, last)
      wheel(79, last)
      wheel(5, transcript)
      wheel(5, input)
      await Bun.sleep(40)
      expect(s.live()).toContain("HITROW-39")
      wheel(5, last)
      await waitFor(() => !s.live().includes("HITROW-39"), "wheel at actual dock row")
      s.terminal.send("\x1b[F")
      await waitFor(() => s.live().includes("HITROW-39"), "follow after actual wheel")
      s.screen.resize(70, 30)
      s.terminal.setSize(70, 30)
      await waitFor(() => s.live().includes("HITROW-39"), "dock after resize")
      await Bun.sleep(40)
      wheel(
        5,
        s.screen.lines.findIndex((line) => line.includes("HITROW-39")),
      )
      await waitFor(() => !s.live().includes("HITROW-39"), "wheel after resize")
      s.terminal.send("\x1b[F?")
      await waitFor(() => s.live().includes("Keys"), "covering key reference")
      s.terminal.send(ESC)
      await waitFor(() => s.live().includes("HITROW-39"), "dock restored after overlay")
      wheel(
        5,
        s.screen.lines.findIndex((line) => line.includes("HITROW-39")),
      )
      await waitFor(() => !s.live().includes("HITROW-39"), "wheel after overlay")
      s.terminal.send(ESC)
      await waitFor(() => !s.live().includes("Bounded dock"), "bounded dock closed")
      expect(s.live()).toContain("Short main transcript")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: a dock scrolls, follows, respects margins, and leaves editing keys in the input`, async () => {
    const data = { rows: Array.from({ length: 40 }, (_, i) => `ROW-${String(i).padStart(2, "0")}`) }
    let closeCount = 0
    let rendersMarkdown = false
    const definition: ViewDefinition<typeof data> = {
      kind: "dock",
      title: () => "Side question",
      onClose: () => {
        closeCount++
      },
      render: (d, options) => {
        const reply = options.renderReply?.("**Dock answer**") ?? []
        rendersMarkdown = reply.length > 0
        return [...reply, ...d.rows.map((text) => ({ kind: "text" as const, text }))]
      },
    }
    const s = await setup([], {
      cols: 80,
      rows: 32,
      settings: { mode, margin: 3, marginRows: 1 },
      extensions: [
        (api) => {
          api.registerView(definition)
          api.registerCommand({
            name: "dock",
            description: "open dock",
            echo: false,
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "dock", data, placement: "dock", maxHeight: 10 })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/dock\r")
      await waitFor(() => s.live().includes("ROW-39"), "dock following last row")
      expect(rendersMarkdown).toBe(true)
      expect(s.live()).toContain("follow · esc close dock")
      const title = s.screen.lines.find((line) => line.includes("Side question"))!
      expect(title).toStartWith("   ")
      const row = s.screen.lines.findIndex((line) => line.includes("ROW-39"))
      const input = s.screen.lines.findIndex((line) => line.includes("Message Amira"))
      expect(row).toBeLessThan(input)

      s.terminal.send("draft\x1b[D")
      await waitFor(() => s.live().includes("draft"), "input remains usable")
      expect(s.live()).toContain("ROW-39")
      s.terminal.send("\x1b[5~")
      await waitFor(() => !s.live().includes("ROW-39"), "page up scrolls dock")
      const before = s.screen.lines.filter((line) => line.includes("ROW-")).join("\n")
      data.rows.push("ROW-40")
      s.terminal.send("x")
      await Bun.sleep(40)
      expect(s.screen.lines.filter((line) => line.includes("ROW-")).join("\n")).toBe(before)
      s.terminal.send("\x1b[6~\x1b[F")
      await waitFor(() => s.live().includes("ROW-40"), "page down and End follow")
      const wheelRow = s.screen.lines.findIndex((line) => line.includes("ROW-40"))
      s.terminal.send(`\x1b[<64;6;${wheelRow + 1}M`)
      await waitFor(() => !s.live().includes("ROW-40"), "wheel over dock scrolls")
      s.terminal.send("\x1b[F")
      await waitFor(() => s.live().includes("ROW-40"), "End follows after wheel")
      const outsideRow = s.screen.lines.findIndex((line) => line.includes("drafxt"))
      s.terminal.send(`\x1b[<64;6;${outsideRow + 1}M`)
      await Bun.sleep(40)
      expect(s.live()).toContain("ROW-40")
      s.terminal.send(ESC)
      await waitFor(() => closeCount === 1 && !s.live().includes("Side question"), "Esc closes dock")
      expect(s.live()).toContain("drafxt")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: Esc closes a dock before it interrupts a running main turn`, async () => {
    let closed = false
    const s = await setup([{ text: "main answer", delayMs: 10000 }], {
      settings: { mode },
      rows: 32,
      extensions: [
        (api) => {
          api.registerView({
            kind: "dock",
            title: () => "Side question",
            render: () => [{ kind: "text", text: "side answer" }],
            onClose: () => {
              closed = true
            },
          })
          api.registerCommand({
            name: "dock",
            description: "open dock",
            echo: false,
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "dock", placement: "dock" })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("main question\r")
      await waitFor(() => s.agent.busy, "main turn running")
      s.terminal.send("/dock\r")
      await waitFor(() => s.live().includes("Side question"), "dock open during turn")
      s.terminal.send(ESC)
      await waitFor(() => closed, "first Esc closes dock")
      expect(s.agent.busy).toBe(true)
      s.terminal.send(ESC)
      await s.idle()
      expect(s.agent.busy).toBe(false)
      expect(s.all()).toContain("Interrupted")
    } finally {
      s.agent.abort()
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: Esc closes a dock before cancelling the command that opened it`, async () => {
    let commandContext: CommandContext | undefined
    let closed = 0
    const s = await setup([], {
      settings: { mode },
      rows: 32,
      extensions: [
        (api) => {
          api.registerView({
            kind: "dock",
            title: () => "Command dock",
            render: () => [],
            onClose: () => {
              closed++
            },
          })
          api.registerCommand({
            name: "hold",
            description: "wait for cancellation",
            echo: false,
            run: async (_args, ctx) => {
              commandContext = ctx
              ctx.openView?.({ kind: "dock", placement: "dock" })
              await new Promise<void>((resolve) =>
                ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
              )
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/hold\r")
      await waitFor(() => s.live().includes("Command dock"), "command dock open")
      s.terminal.send(ESC)
      await waitFor(() => closed === 1, "dock closed first")
      expect(commandContext?.signal.aborted).toBe(false)
      s.terminal.send(ESC)
      await waitFor(() => !!commandContext?.signal.aborted, "second Esc cancels command")
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })
}
