import { expect, test } from "bun:test"
import { emptyUsage } from "@amira/api"
import { ThemeRegistry } from "@amira/core"
import { agentsCommand } from "../../../extensions/agent/src/index.ts"
import { subagentView } from "../../../extensions/agent/src/subagent-view.ts"
import { setup, waitFor } from "./app-harness.ts"

function asciiThemes() {
  const themes = new ThemeRegistry()
  themes.register(
    {
      name: "ascii",
      glyphs: { pointer: ">", user: ">", separator: "|", bullets: ["*"], quoteBar: ">", taskDone: "[x]" },
    },
    "user",
  )
  return themes
}

test("the actual /agents viewer uses configured ASCII message and Markdown glyphs", async () => {
  const app = await setup([], {
    cols: 80,
    rows: 30,
    themes: asciiThemes(),
    settings: { mode: "fullscreen", theme: "ascii" },
    control: {
      subagents: () => [
        {
          id: "child",
          parentSessionId: "main",
          depth: 1,
          role: "explorer",
          title: "Check files",
          task: "Check files",
          status: "done",
          usage: emptyUsage(),
        },
      ],
      subagentMessages: () => [
        { role: "user", content: [{ type: "text", text: "Check files" }] },
        {
          role: "assistant",
          model: { provider: "mock", model: "m1" },
          content: [{ type: "text", text: "- ASCII bullet\n\n> ASCII quote\n\n- [x] ASCII task" }],
        },
      ],
    },
    extensions: [
      (api) => {
        api.registerCommand(agentsCommand())
        api.registerView(subagentView(api))
      },
    ],
  })
  app.host.setSessionControl(app.commands!.control, () => app.agent)
  try {
    app.terminal.send("/agents view child\r")
    await waitFor(() => app.screen.inAltScreen && app.live().includes("ASCII bullet"), "agents Markdown")
    expect(app.live()).toContain("* ASCII bullet")
    expect(app.live()).toContain("> ASCII quote")
    expect(app.live()).toContain("[x] ASCII task")
    expect(app.live()).not.toMatch(/[›•▎✓]/)
    expect(app.screen.lines.find((line) => line === "> Check files")).toBe("> Check files")
  } finally {
    app.terminal.send("\x1b[27u\x03\x03")
    await app.exited
  }
})

test("a real ui.form request receives configured ASCII pointer and separator glyphs", async () => {
  const app = await setup([], { themes: asciiThemes(), settings: { theme: "ascii" } })
  const result = app.host.ui.api("test").form({
    title: "Choose mode",
    fields: [{ id: "mode", type: "select", label: "Mode", options: [{ value: "a", label: "Alpha" }] }],
  })
  try {
    await waitFor(() => app.screen.inAltScreen && app.live().includes("Choose mode"), "ASCII form")
    expect(app.live()).toContain("> Mode")
    expect(app.live()).toContain(" | ")
    app.terminal.send("\r")
    await waitFor(() => app.live().includes("> * Alpha"), "ASCII form option")
    expect(app.live()).not.toMatch(/[›·●]/)
    app.terminal.send("\x1b[27u\t")
    await waitFor(() => app.live().includes("> [ Save ]"), "ASCII form save")
  } finally {
    app.terminal.send("\x1b[27u\x03\x03")
    await result
    await app.exited
  }
})
