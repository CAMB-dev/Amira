import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import type { UiApi } from "@amira/api"
import { Agent } from "@amira/core"
import { closeImageApp, paste, setup, testCommands, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: ghost text accepts with Tab without sending, then submits the edited suggestion`, async () => {
    let ui!: UiApi
    const accepted: string[] = []
    const s = await setup([{ text: "Done." }], {
      settings: { mode },
      extensions: [
        (api) => {
          ui = api.ui
          ui.onInputSuggestionAccepted((text) => accepted.push(text))
        },
      ],
    })
    try {
      ui.setInputSuggestion("Try tests")
      await waitFor(() => s.live().includes("Try tests"), "ghost text")
      expect(s.mock.requests).toHaveLength(0)
      s.terminal.send("\x1b[C")
      await Bun.sleep(30)
      expect(accepted).toEqual([])
      s.terminal.send("\t now")
      await waitFor(() => s.live().includes("Try tests now"), "accepted text and caret")
      expect(accepted).toEqual(["Try tests"])
      expect(s.mock.requests).toHaveLength(0)
      s.terminal.send("\r")
      await s.shows("Done.")
      await s.idle()
      expect(s.agent.messages[0]?.content).toEqual([{ type: "text", text: "Try tests now" }])
      expect(s.host.ui.inputSuggestions.text).toBeUndefined()
    } finally {
      await closeImageApp(s)
    }
  })
}

test("typing, paste and history discard ghost text, and completion Tab still belongs to its popup", async () => {
  const s = await setup([], { commands: testCommands([]), files: ["code.ts"] })
  const ui = s.host.ui.api("test")
  try {
    for (const input of ["x", paste("pasted"), "\x1b[A", "\x12"]) {
      ui.setInputSuggestion("Temporary ghost")
      await waitFor(() => s.live().includes("Temporary ghost"), "suggestion before editing")
      s.terminal.send(input)
      await waitFor(() => s.host.ui.inputSuggestions.text === undefined, "suggestion discarded")
      if (input === "\x12") {
        s.terminal.send("\x1b")
        await Bun.sleep(50)
      }
      s.terminal.send("\x15")
      await Bun.sleep(30)
    }
    s.terminal.send("draft")
    await waitFor(() => s.live().includes("draft"), "draft before late prediction")
    ui.setInputSuggestion("Late hidden ghost")
    s.terminal.send("\x15")
    await waitFor(() => s.host.ui.inputSuggestions.text === undefined, "editing clears hidden prediction")
    expect(s.live()).not.toContain("Late hidden ghost")
    s.terminal.send("/he")
    await waitFor(() => s.live().includes("/help"), "command popup")
    ui.setInputSuggestion("Hidden command ghost")
    await Bun.sleep(30)
    expect(s.live()).not.toContain("Hidden command ghost")
    s.terminal.send("\t")
    await waitFor(() => s.live().includes("› /help"), "command completion")
    s.terminal.send("\r")
    await s.shows("HELP TEXT")
    expect(s.host.ui.inputSuggestions.text).toBeUndefined()
    s.terminal.send("@co")
    await waitFor(() => s.live().includes("code.ts"), "file popup")
    ui.setInputSuggestion("Hidden file ghost")
    await Bun.sleep(30)
    expect(s.live()).not.toContain("Hidden file ghost")
    s.terminal.send("\t")
    await waitFor(() => s.live().includes("@code.ts"), "file completion")
  } finally {
    await closeImageApp(s)
  }
})

test("Ctrl+C clearing a draft discards a hidden late suggestion instead of revealing or accepting it", async () => {
  let ui!: UiApi
  const accepted: string[] = []
  const s = await setup([], {
    extensions: [
      (api) => {
        ui = api.ui
        ui.onInputSuggestionAccepted((text) => accepted.push(text))
      },
    ],
  })
  try {
    s.terminal.send("draft before cancellation")
    await waitFor(() => s.live().includes("draft before cancellation"), "draft")
    ui.setInputSuggestion("Stale cancellation ghost")
    await s.bus.flush()
    await Bun.sleep(30)
    expect(s.live()).not.toContain("Stale cancellation ghost")
    s.terminal.send("\x03")
    await waitFor(() => !s.live().includes("draft before cancellation"), "cancelled draft")
    expect(s.host.ui.inputSuggestions.text).toBeUndefined()
    expect(s.live()).not.toContain("Stale cancellation ghost")
    s.terminal.send("\t")
    await Bun.sleep(30)
    expect(accepted).toEqual([])
    expect(s.live()).not.toContain("Stale cancellation ghost")
    expect(s.mock.requests).toHaveLength(0)
  } finally {
    await closeImageApp(s)
  }
})

test("dialogs, secret inputs and forms never render or accept prompt suggestions", async () => {
  const s = await setup([])
  const ui = s.host.ui.api("test")
  try {
    for (const secret of [false, true]) {
      const answer = ui.input("Dialog input", { secret })
      await waitFor(() => s.live().includes("Dialog input"), "input dialog")
      ui.setInputSuggestion("Private ghost")
      await Bun.sleep(30)
      expect(s.live()).not.toContain("Private ghost")
      s.terminal.send("\t")
      await Bun.sleep(30)
      expect(s.host.ui.inputSuggestions.text).toBe("Private ghost")
      s.terminal.send("\x1b")
      expect(await answer).toBeUndefined()
    }
    const answer = ui.form({ title: "Form input", fields: [{ id: "name", type: "text", label: "Name" }] })
    await waitFor(() => s.live().includes("Form input"), "form")
    ui.setInputSuggestion("Form ghost")
    await Bun.sleep(30)
    expect(s.live()).not.toContain("Form ghost")
    s.terminal.send("\t")
    await Bun.sleep(30)
    expect(s.host.ui.inputSuggestions.text).toBe("Form ghost")
    s.terminal.send("\x1b")
    expect(await answer).toBeUndefined()
  } finally {
    await closeImageApp(s)
  }
})

test("turn start and committed session switches clear even suggestions set while a draft is hidden", async () => {
  const s = await setup([{ text: "Turn finished." }], {
    commands: testCommands([]),
    control: {
      newSession: async () => {
        s.commands!.switchTo(new Agent({ ai: s.ai, model: s.agent.model, cwd: s.agent.cwd, bus: s.bus }))
      },
    },
  })
  const ui = s.host.ui.api("test")
  try {
    ui.setInputSuggestion("Before turn")
    await waitFor(() => s.live().includes("Before turn"), "first ghost")
    await s.agent.prompt(userMessage("external prompt"))
    await s.idle()
    expect(s.host.ui.inputSuggestions.text).toBeUndefined()
    ui.setInputSuggestion("Before switch")
    await waitFor(() => s.live().includes("Before switch"), "second ghost")
    const next = new Agent({ ai: s.ai, model: s.agent.model, cwd: s.agent.cwd, bus: s.bus })
    s.commands!.switchTo(next)
    await waitFor(() => !s.live().includes("Before switch"), "switched session")
    expect(s.host.ui.inputSuggestions.text).toBeUndefined()
    s.terminal.send("/clear")
    await waitFor(() => s.live().includes("› /clear"), "clear command")
    ui.setInputSuggestion("Hidden before clear")
    s.terminal.send("\r")
    await waitFor(() => s.host.ui.inputSuggestions.text === undefined, "clear discarded suggestion")
    expect(s.live()).not.toContain("Hidden before clear")
  } finally {
    await closeImageApp(s)
  }
})
