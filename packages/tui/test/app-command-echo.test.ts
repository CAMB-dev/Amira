import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { defaultTheme, stripAnsi, surfaceTheme } from "@amira/tui-kit"
import { commandEchoLines, userLines } from "../src/format.ts"
import { PromptHistory } from "../src/prompt-history.ts"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

test("commands use plain muted rows while actual model messages retain the user band", () => {
  const theme = { ...defaultTheme, ...surfaceTheme("dark") }
  expect(commandEchoLines(theme, "/theme", 40)).toEqual([`  ${theme.muted("› /theme")}`])
  const wrapped = commandEchoLines(theme, "/theme a long command line", 17).map(stripAnsi)
  expect(wrapped).toEqual(["  › /theme a long", "    command line"])
  const rows = userLines(theme, userMessage("Hello model"), 40)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toBe(`\x1b[48;2;32;32;32m${" ".repeat(40)}\x1b[49m`)
  expect(stripAnsi(rows[1]!)).toBe(`  › Hello model${" ".repeat(25)}`)
  expect(rows[1]).toContain("\x1b[48;")
  expect(rows[2]).toBe(rows[0])
})

for (const mode of ["fullscreen", "inline"] as const) {
  for (const name of ["swarm", "workflow"]) {
    test(`${mode}: /${name} task is echoed once when the command sends its display line`, async () => {
      const line = `/${name} fix the build`
      const prompt = `Use a ${name} (the ${name} tool) for this task: fix the build`
      const s = await setup([{ text: "Done." }], {
        settings: { mode },
        commands: [
          {
            name,
            description: `Run a ${name}`,
            run: (args, ctx) =>
              ctx.session.send(`Use a ${name} (the ${name} tool) for this task: ${args}`, {
                display: { text: `/${name} ${args}` },
              }),
          },
        ],
        control: {
          send: async (text, opts) => {
            await s.agent.prompt(userMessage(text, opts?.display))
          },
        },
      })
      try {
        s.terminal.send(`${line}\r`)
        await s.shows("Done.")
        await s.idle()
        expect(s.all().split(`› ${line}`)).toHaveLength(2)
        expect(s.all()).not.toContain(prompt)
        expect(s.agent.messages[0]).toEqual(userMessage(prompt, { text: line }))
      } finally {
        await closeImageApp(s)
      }
    })
  }

  for (const echo of [undefined, true, false]) {
    test(`${mode}: echo=${echo} controls only the typed command line`, async () => {
      const history = new PromptHistory()
      const s = await setup([], {
        settings: { mode },
        promptHistory: history,
        commands: [
          {
            name: "btw",
            description: "Ask a side question",
            ...(echo === undefined ? {} : { echo }),
            run: (_args, ctx) => ctx.print("Side answer"),
          },
        ],
      })
      try {
        s.terminal.send("/btw question\r")
        await s.shows("Side answer")
        await s.idle()
        expect(s.all().includes("/btw question")).toBe(echo !== false)
        expect(s.agent.messages).toHaveLength(0)
        expect(history.entries.map((entry) => entry.text)).toEqual(["/btw question"])
        s.terminal.send("\x1b[A")
        await waitFor(() => s.live().includes("› /btw question"), "command recalled")
      } finally {
        await closeImageApp(s)
      }
    })
  }

  test(`${mode}: a silent command leaves no transcript line through aliases or completion`, async () => {
    let runs = 0
    const s = await setup([], {
      settings: { mode },
      aliases: { aside: "btw fixed" },
      commands: [
        {
          name: "btw",
          aliases: ["b"],
          description: "Ask a side question",
          echo: false,
          run: () => void runs++,
        },
      ],
    })
    try {
      for (const line of ["/btw question", "/b question", "/aside question"]) {
        const before = runs
        s.terminal.send(`${line}\r`)
        await waitFor(() => runs > before, "silent command completed")
        await s.idle()
        expect(s.all()).not.toContain(line)
      }
      s.terminal.send("/bt")
      await waitFor(() => s.live().includes("❯ /btw"), "command completion")
      s.terminal.send("\r")
      await waitFor(() => runs === 4, "completed command ran")
      await s.idle()
      expect(s.all()).not.toContain("/btw")
      expect(s.agent.messages).toHaveLength(0)
    } finally {
      await closeImageApp(s)
    }
  })

  test(`${mode}: echo=false does not deduplicate a message the command explicitly sends`, async () => {
    const s = await setup([{ text: "Done." }], {
      settings: { mode },
      commands: [
        {
          name: "send",
          description: "Send a message",
          echo: false,
          run: (_args, ctx) =>
            ctx.session.send("Actual prompt", { display: { text: "/send", note: "Loaded prompt" } }),
        },
      ],
      control: {
        send: async (text, opts) => {
          await s.agent.prompt(userMessage(text, opts?.display))
        },
      },
    })
    try {
      s.terminal.send("/send\r")
      await s.shows("Done.")
      await s.idle()
      expect(s.all().match(/› \/send/g)).toHaveLength(1)
      expect(s.all()).toContain("Loaded prompt")
      expect(s.agent.messages[0]).toEqual(
        userMessage("Actual prompt", { text: "/send", note: "Loaded prompt" }),
      )
    } finally {
      await closeImageApp(s)
    }
  })
}
