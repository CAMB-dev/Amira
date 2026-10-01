import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import type { CommandDefinition } from "@amira/api"
import type { Agent } from "@amira/core"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { closeImageApp, setup, skillSetup, testCommands, testSkill, waitFor } from "./app-harness.ts"

test("typing a slash opens the command list below the editor; Tab and Enter complete and run", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/")
  await waitFor(() => live().includes("/status"), "popup")
  const rows = live().split("\n")
  const popupRow = rows.findIndex((l) => l.includes("/clear"))
  // The editor sits in the input box: "│ › /     │".
  const editorRow = rows.findIndex((l) => /^│ › \/ *│$/.test(l.trimEnd()))
  expect(editorRow).toBeGreaterThan(-1)
  expect(popupRow).toBeGreaterThan(editorRow)
  // The list takes the place of the status bar and the hint, and ends with its own hint.
  expect(rows.filter((l) => l.trim()).at(-1)).toContain("Tab complete · Enter run · Esc close")
  expect(rows.slice(editorRow).join("\n")).not.toContain("mock/m1")
  expect(live()).not.toContain("Enter send")
  // Prefix first: "/he" puts help on top; Tab completes it, Enter runs it.
  terminal.send("he")
  await waitFor(() => live().includes("❯ /help"), "help selected")
  terminal.send("\t")
  await waitFor(() => live().includes("› /help "), "completed")
  terminal.send("\r")
  await shows("HELP TEXT")
  expect(live()).toContain("› Message Amira")
  terminal.send("\x03")
  await exited
})

test("typing a command: the input box stays put and each key draws one frame with its list", async () => {
  const frames: string[][] = []
  const { terminal, live, exited } = await setup([], {
    commands: testCommands([]),
    onWrite: (screen) => void frames.push([...screen.lines]),
  })
  await waitFor(() => live().includes("Enter send"), "first frame")
  await Bun.sleep(40)
  const boxTop = (lines: string[]) => lines.findIndex((l) => l.startsWith("╭"))
  const top = boxTop(frames.at(-1)!)
  expect(top).toBeGreaterThan(-1)
  /** The rows between the box's bottom edge and the popup's hint. */
  const list = (lines: string[]) => {
    const start = lines.findIndex((l) => l.startsWith("╰")) + 1
    const end = lines.findIndex((l) => l.startsWith("Tab complete"))
    return end === -1 ? [] : lines.slice(start, end).map((l) => l.trimEnd())
  }
  const steps: [string, string[]][] = [
    [
      "/",
      [
        // Nothing marked on a bare "/"; names show the arguments they take.
        "  /clear                   Start a new session",
        "  /help                    List the slash commands",
        "  /model [provider/model]  Switch the model",
        "  /quit                    Leave Amira",
        "  /status                  Show the status",
      ],
    ],
    ["m", ["❯ /model [provider/model]  Switch the model"]],
    ["o", ["❯ /model [provider/model]  Switch the model"]],
    ["d", ["❯ /model [provider/model]  Switch the model"]],
    ["e", ["❯ /model [provider/model]  Switch the model"]],
    ["l", ["❯ /model [provider/model]  Switch the model"]],
    [" ", ["❯ deepseek/deepseek-flash", "  deepseek/deepseek-pro", "  openai/gpt-5"]],
    ["d", ["❯ deepseek/deepseek-flash", "  deepseek/deepseek-pro"]],
  ]
  for (const [k, expected] of steps) {
    const before = frames.length
    terminal.send(k)
    await Bun.sleep(60)
    const drawn = frames.slice(before)
    expect({ key: k, frames: drawn.length }).toEqual({ key: k, frames: 1 })
    expect(boxTop(drawn[0]!)).toBe(top)
    expect(list(drawn[0]!)).toEqual(expected)
  }
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("async argument candidates get a frame to arrive, so the key still draws once", async () => {
  const frames: string[][] = []
  const { terminal, live, exited } = await setup([], {
    commands: [
      {
        name: "pick",
        description: "Pick",
        args: {
          complete: async () => {
            await Bun.sleep(3)
            return [{ value: "alpha" }, { value: "beta" }]
          },
        },
        run: () => {},
      },
    ],
    onWrite: (screen) => void frames.push([...screen.lines]),
  })
  terminal.send("/pick")
  await waitFor(() => live().includes("❯ /pick"), "popup")
  await Bun.sleep(40)
  const before = frames.length
  terminal.send(" ")
  await Bun.sleep(80)
  const drawn = frames.slice(before)
  expect(drawn).toHaveLength(1)
  expect(drawn[0]!.join("\n")).toContain("❯ alpha")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: a command's matching display text is echoed once and remains rewindable`, async () => {
    const longPrompt = "Investigate the project and coordinate workers to accomplish the goal."
    const s = await setup([{ text: "Workers finished." }, { text: "Next answer." }], {
      settings: { mode },
      commands: [
        {
          name: "swarm",
          description: "Coordinate workers",
          run: async (goal, ctx) => {
            await Bun.sleep(5)
            await ctx.session.send(longPrompt, {
              display: { text: `/swarm ${goal}`, note: "Coordinating workers" },
            })
          },
        },
      ],
      control: {
        send: async (text, opts) => {
          await s.agent.prompt(userMessage(text, opts?.display))
        },
        rewind: async () => {},
      },
    })
    try {
      s.terminal.send("/swarm goal\r")
      await s.shows("Workers finished.")
      await s.idle()
      expect(s.all().match(/› \/swarm goal/g)).toHaveLength(1)
      expect(s.all()).not.toContain(longPrompt)
      // The note of what it loaded hangs under the echo, as the command's own output would.
      expect(s.all()).toContain("› /swarm goal\n\n  └ Coordinating workers")
      expect(s.agent.messages[0]).toEqual(
        userMessage(longPrompt, { text: "/swarm goal", note: "Coordinating workers" }),
      )
      s.terminal.send("\x1b[27u\x1b[27u")
      await waitFor(() => s.live().includes("? Rewind the conversation"), "rewind picker")
      expect(s.live()).toContain("❯ 1 /swarm goal")
      s.terminal.send("\x1b[27u")
      // A later, unrelated message with the same display must not lose its own echo.
      await s.agent.prompt(userMessage("another prompt", { text: "/swarm goal" }))
      await s.shows("Next answer.")
      await s.idle()
      expect(s.all().match(/› \/swarm goal/g)).toHaveLength(2)
    } finally {
      await closeImageApp(s)
    }
  })
}

for (const delivery of ["injected", "promoted"] as const) {
  for (const mode of ["fullscreen", "inline"] as const) {
    test(`${mode}: a command sent while busy is echoed once when ${delivery}`, async () => {
      let release!: () => void
      const until = new Promise<void>((resolve) => {
        release = resolve
      })
      let sent = false
      const s = await setup(
        [
          {
            text: "First reply.",
            hold: { chunks: 0, until },
            ...(delivery === "injected" ? { toolCalls: [{ name: "read", args: { path: "a.ts" } }] } : {}),
          },
          { text: "Workers finished." },
        ],
        {
          settings: { mode },
          commands: [
            {
              name: "swarm",
              description: "Coordinate workers",
              run: async (_goal, ctx) => {
                await ctx.session.send("long prompt", {
                  display: { text: "/swarm goal", note: "Coordinating workers" },
                })
                sent = true
              },
            },
          ],
          control: {
            send: async (text, opts) => {
              const message = userMessage(text, opts?.display)
              if (s.agent.busy) s.agent.steer(message)
              else await s.agent.prompt(message)
            },
          },
        },
      )
      try {
        s.terminal.send("go\r")
        await waitFor(() => s.agent.status === "working", "busy turn")
        s.terminal.send("/swarm goal\r")
        await waitFor(() => sent, "command completed while busy")
        release()
        await s.shows("Workers finished.")
        await s.idle()
        expect(s.all().match(/› \/swarm goal/g)).toHaveLength(1)
        // Its turn was busy: the note, no longer under the echo, shows as a notice.
        expect(s.all()).toContain("• Coordinating workers")
        expect(s.agent.messages.filter((m) => m.role === "user")).toHaveLength(2)
      } finally {
        release()
        await closeImageApp(s)
      }
    })
  }
}

test("a command's different display text still shows alongside its command echo", async () => {
  const s = await setup([{ text: "Done." }], {
    commands: [
      {
        name: "swarm",
        description: "Coordinate workers",
        run: (_goal, ctx) => ctx.session.send("long prompt", { display: { text: "Workers' task" } }),
      },
    ],
    control: {
      send: async (text, opts) => {
        await s.agent.prompt(userMessage(text, opts?.display))
      },
    },
  })
  try {
    s.terminal.send("/swarm goal\r")
    await s.shows("Done.")
    await s.idle()
    expect(s.all()).toContain("› /swarm goal")
    expect(s.all()).toContain("› Workers' task")
  } finally {
    await closeImageApp(s)
  }
})

test("a command's echo and everything it prints reach the screen in one frame", async () => {
  const writes: string[] = []
  const { terminal, live, shows, exited } = await setup([], {
    commands: [
      {
        name: "chatty",
        description: "Prints twice",
        run: (_a, ctx) => {
          ctx.print("first line")
          ctx.print("second line")
        },
      },
    ],
    onWrite: (screen) => void writes.push(screen.lines.join("\n")),
  })
  terminal.send("/chatty")
  await waitFor(() => live().includes("❯ /chatty"), "popup")
  await Bun.sleep(40)
  const before = writes.length
  terminal.send("\r")
  await shows("second line")
  await Bun.sleep(60)
  const drawn = writes.slice(before)
  expect(drawn).toHaveLength(1)
  expect(drawn[0]).toContain("first line")
  terminal.send("\x03")
  await exited
})

test("arguments complete after the name, ↑↓ pick one and Enter runs with it", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/model ")
  await waitFor(() => live().includes("openai/gpt-5"), "model candidates")
  terminal.send("\x1b[B\x1b[B")
  await waitFor(() => live().includes("❯ openai/gpt-5"), "selection moved")
  terminal.send("\r")
  await shows("Model: openai/gpt-5")
  // Part of a candidate typed: Enter takes the best match.
  terminal.send("/model flash")
  await waitFor(() => live().includes("❯ deepseek/deepseek-flash"), "filtered")
  terminal.send("\r")
  await shows("Model: deepseek/deepseek-flash")
  expect(log).toEqual(["model openai/gpt-5", "model deepseek/deepseek-flash"])
  terminal.send("\x03")
  await exited
})

test("keys arriving in one chunk are not answered by the popup of the previous frame", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/model deep")
  await waitFor(() => live().includes("❯ deepseek/deepseek-flash"), "candidates for deep")
  terminal.send("seek/deepseek-pro\r")
  await shows("Model: deepseek/deepseek-pro")
  expect(log).toEqual(["model deepseek/deepseek-pro"])
  terminal.send("\x03")
  await exited
})

test("a command's picker is a select dialog that filters as you type", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/model")
  await waitFor(() => live().includes("❯ /model"), "popup")
  terminal.send("\r")
  await waitFor(() => live().includes("? Model"), "picker")
  terminal.send("gpt")
  await waitFor(() => live().includes("filter ❯ gpt") && !live().includes("deepseek-pro"), "filtered")
  terminal.send("\r")
  await shows("Model: openai/gpt-5")
  terminal.send("\x03")
  await exited
})

test("Esc closes the popup without leaving the text; Enter then runs what was typed", async () => {
  const log: string[] = []
  const { terminal, live, all, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/sta")
  await waitFor(() => live().includes("❯ /status"), "popup")
  terminal.send("\x1b[27u")
  await waitFor(() => !live().includes("Show the status"), "closed")
  expect(live()).toContain("› /sta")
  terminal.send("tus\r")
  await shows("STATUS OK")
  expect(all()).toContain("› /status")
  terminal.send("\x03")
  await exited
})

test("unknown commands are reported and not sent to the model; slash paths are messages", async () => {
  const { terminal, agent, shows, idle, exited } = await setup([{ text: "a path" }], {
    commands: testCommands([]),
  })
  terminal.send("/nope\r")
  await shows("Unknown command /nope")
  expect(agent.messages).toEqual([])
  terminal.send("/usr/bin is empty\r")
  await shows("a path")
  await idle()
  expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(1)
  terminal.send("\x03")
  await exited
})

test("a command that sends a long prompt shows as typed, with its note, while the model gets it all", async () => {
  let agent!: Agent
  const long = Array.from({ length: 40 }, (_, i) => `instruction line ${i}`).join("\n")
  const skill: CommandDefinition = {
    name: "review-pr",
    description: "A skill",
    run: (args, ctx) =>
      ctx.session.send(long, {
        display: { text: `/review-pr ${args}`, note: "Loaded skill review-pr (40 lines)" },
      }),
  }
  const s = await setup([{ text: "Reviewing." }], {
    commands: [skill],
    control: {
      send: async (text, opts) => {
        await agent.prompt(userMessage(text, opts?.display))
      },
    },
  })
  agent = s.agent
  s.terminal.send("/review-pr 123\r")
  await s.shows("Reviewing.")
  await s.idle()
  const text = s.all()
  expect(text.match(/› \/review-pr 123/g)).toHaveLength(1)
  expect(text).toContain("› /review-pr 123\n\n  └ Loaded skill review-pr (40 lines)")
  expect(text).not.toContain("instruction line")
  const sent = s.mock.requests[0]!.messages[0]!
  expect(sent).toEqual({ role: "user", content: [{ type: "text", text: long }] })
  s.terminal.send("\x03")
  await s.exited
})

test("typing $ opens the skill list; Enter runs the skill, shown as typed with its note", async () => {
  const { terminal, live, all, mock, shows, idle, exited } = await skillSetup([{ text: "Reviewing." }])
  terminal.send("$")
  await waitFor(() => live().includes("$review-pr"), "skill popup")
  expect(live()).toContain("$deploy")
  expect(live()).toContain("Review a pull request")
  // Skills are not commands: the "/" list leaves them out.
  expect(live().split("╰")[1]).not.toContain("/help")
  expect(live()).toContain("Tab complete · Enter run · Esc close")
  terminal.send("rev")
  await waitFor(() => live().includes("❯ $review-pr"), "review-pr selected")
  terminal.send("\t")
  await waitFor(() => live().includes("$review-pr [arguments]"), "usage")
  terminal.send("123\r")
  await shows("Reviewing.")
  await idle()
  expect(all()).toContain("› $review-pr 123\n  └ Loaded skill review-pr (3 lines)")
  expect(all()).not.toContain("SKILL review-pr BODY")
  expect(mock.requests[0]!.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "SKILL review-pr BODY 123" }],
  })
  terminal.send("\x03")
  await exited
})

test("the / list has no skills, and /<skill> points at $ instead of running it", async () => {
  const { terminal, live, agent, shows, exited } = await skillSetup([], { cols: 100 })
  terminal.send("/")
  await waitFor(() => live().includes("/status"), "command popup")
  expect(live()).not.toContain("review-pr")
  terminal.send("de")
  await Bun.sleep(30)
  expect(live()).not.toContain("deploy")
  // Ctrl+C clears the input.
  terminal.send("\x03")
  await waitFor(() => live().includes("Message Amira"), "cleared")
  terminal.send("/deploy now\r")
  await shows("Unknown command /deploy — skills now start with $: $deploy")
  expect(agent.messages).toEqual([])
  terminal.send("\x03")
  await exited
})

test("a line an input handler claims runs at once, also during a turn, and never reaches the model", async () => {
  const got: string[] = []
  const { terminal, agent, all, shows, idle, mock, exited } = await setup(
    [{ text: "Working on it.", delayMs: 300 }, { text: "Hello." }],
    {
      commands: testCommands([]),
      inputs: [
        {
          name: "swarm",
          claims: (t) => /^@writer\s/.test(t),
          run: (t, ctx) => {
            got.push(t)
            ctx.print("→ writer: message sent")
          },
        },
      ],
    },
  )
  terminal.send("start\r")
  await waitFor(() => agent.status === "working", "turn")
  terminal.send("@writer keep it short\r")
  await shows("→ writer: message sent")
  expect(got).toEqual(["@writer keep it short"])
  await idle()
  expect(all()).toContain("› @writer keep it short")
  // Not steered into the turn: the model only ever saw the first message.
  expect(mock.requests).toHaveLength(1)
  expect(JSON.stringify(agent.messages)).not.toContain("keep it short")
  // A line nobody claims is a message as usual.
  terminal.send("@reader hi\r")
  await shows("Hello.")
  expect(JSON.stringify(mock.requests[1]!.messages)).toContain("@reader hi")
  terminal.send("\x03")
  await exited
})

test("text that starts with $ but names no skill is sent as a message", async () => {
  const { terminal, agent, all, live, shows, idle, exited } = await skillSetup(
    [{ text: "Noted." }, { text: "Sure." }],
    { skills: [testSkill("home-assistant", "Smart home")] },
  )
  terminal.send("$100 is the price\r")
  await shows("Noted.")
  await idle()
  // "$HOME" lists home-assistant, but only its case-exact start would run it: Enter sends it.
  terminal.send("$HOME")
  await waitFor(() => live().includes("❯ $home-assistant"), "listed")
  terminal.send("\r")
  await shows("Sure.")
  await idle()
  const users = agent.messages.filter((m) => m.role === "user")
  expect(users.map((m) => (m.content[0] as { text: string }).text)).toEqual(["$100 is the price", "$HOME"])
  expect(all()).not.toContain("Unknown")
  terminal.send("\x03")
  await exited
})

test("the $ list takes its keys from the keybindings like the / list", async () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "popup.down": ["ctrl+n"],
    "popup.accept": ["ctrl+y"],
    "popup.close": ["ctrl+g"],
  })
  const { terminal, live, all, shows, idle, exited } = await skillSetup([{ text: "Deployed." }], {
    keybindings: keys,
    cols: 100,
  })
  terminal.send("$")
  await waitFor(() => live().includes("  $deploy"), "skill popup")
  expect(live()).toContain("Ctrl+Y run · Ctrl+G close")
  // A bare "$" marks nothing: the first ↓ marks the first skill.
  terminal.send("\x0e")
  await waitFor(() => live().includes("❯ $deploy"), "first marked")
  terminal.send("\x0e")
  await waitFor(() => live().includes("❯ $review-pr"), "moved down")
  terminal.send("\x0e")
  await waitFor(() => live().includes("❯ $deploy"), "wrapped")
  terminal.send("\x07")
  await waitFor(() => !live().includes("Ship it"), "closed")
  terminal.send("d")
  await waitFor(() => live().includes("❯ $deploy"), "open again")
  terminal.send("\x19")
  await shows("Deployed.")
  await idle()
  expect(all()).toContain("› $deploy\n  └ Loaded skill deploy (3 lines)")
  terminal.send("\x03")
  await exited
})

test("a command typed during a turn runs at once instead of steering it", async () => {
  const { terminal, agent, shows, idle, exited } = await setup(
    [{ text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 }],
    { commands: testCommands([]) },
  )
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  terminal.send("/status")
  await Bun.sleep(20)
  terminal.send("\r")
  await shows("STATUS OK")
  await idle()
  expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(1)
  terminal.send("\x03")
  await exited
})

/** A tool that starts one sub-agent per title, all at once, and waits for them. */
