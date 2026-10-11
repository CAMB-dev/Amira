import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { userMessage } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent, type CommandHost, type ExtensionHost, SessionStore } from "@amira/core"
import { FileIndex } from "../src/file-index.ts"
import { localClock } from "../src/format.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { PromptHistory } from "../src/prompt-history.ts"
import { ALT_ENTER, setup, skillSetup, testCommands, userTexts, waitFor } from "./app-harness.ts"

test("the UI follows the session a command switches to, and /quit leaves", async () => {
  let host!: CommandHost
  let next!: Agent
  const { terminal, shows, idle, exited, ...s } = await setup([{ text: "from the new session" }], {
    commands: testCommands([]),
    control: {
      newSession: async () => {
        next = new Agent({
          ai: s.ai,
          model: s.ai.model("mock/m1"),
          cwd: "/work/proj",
          systemPrompt: "",
          bus: s.bus,
        })
        host.switchTo(next)
      },
    },
  })
  host = s.commands!
  terminal.send("/clear\r")
  await waitFor(() => next !== undefined, "switched")
  terminal.send("hello\r")
  await shows("from the new session")
  await idle()
  expect(next.messages.filter((m) => m.role === "user")).toHaveLength(1)
  expect(s.agent.messages).toEqual([])
  terminal.send("/quit\r")
  expect(await exited).toBe(0)
})

test("inline: a blank line sets the conversation apart from the shell, above the banner and after /quit", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([{ text: "the answer" }], {
    commands: testCommands([]),
  })
  expect(screen.lines[0]).toBe("")
  expect(screen.lines[1]).toContain("Amira")
  terminal.send("hello\r")
  await shows("the answer")
  await idle()
  terminal.send("/quit\r")
  expect(await exited).toBe(0)
  // The cursor, where the shell's prompt goes, is a blank line under the last of it.
  expect(screen.lines[screen.y]).toBe("")
  expect(screen.lines[screen.y - 1]).toBe("")
  // No band padding: the echo is followed by exactly the two blank shell rows.
  expect(screen.lines[screen.y - 2]).toBe("  › /quit")
})

test("inline: Alt+C copies the last reply; a key of the full-screen view says so once", async () => {
  const { terminal, shows, idle, exited } = await setup([{ text: "Use **bold** here." }])
  terminal.send("\x1bc")
  await shows("Nothing to copy in the last reply.")
  terminal.send("go\r")
  await shows("Use bold here.")
  await idle()
  terminal.send("\x1bc")
  await shows("Copied the last reply")
  expect(terminal.output).toContain(`\x1b]52;c;${Buffer.from("Use **bold** here.").toString("base64")}\x07`)
  // With text in the input, Ctrl+↑ is the input's (it moves up in it): no note yet.
  terminal.send("draft")
  await shows("draft")
  terminal.send("\x1b[1;5A")
  terminal.send("\x03")
  terminal.send("\x1b[5~")
  await shows("pgup is for full-screen mode")
  terminal.send("\x03\x03")
  await exited
})

test("a diff review shows the diff above its options", async () => {
  const { host, terminal, live, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "review", args: {} }] },
    { text: "reviewed" },
  ])
  await host.load((api) => {
    api.registerTool(
      defineTool({
        name: "review",
        description: "",
        parameters: {},
        execute: async () =>
          textResult(
            String(
              await api.ui.reviewDiff("Merge?", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n", [
                "merge",
                "keep",
              ]),
            ),
          ),
      }),
    )
  }, "reviewer")
  terminal.send("go\r")
  await waitFor(() => live().includes("? Merge?"), "review dialog")
  expect(live()).toContain("1 - old")
  expect(live()).toContain("1 + new")
  expect(live()).toContain("❯ 1 merge")
  terminal.send("2")
  await idle()
  expect(agent.messages.find((m) => m.role === "toolResult")?.content[0]).toEqual({
    type: "text",
    text: "keep",
  })
  terminal.send("\x03")
  await exited
})

test("a big paste shows as one placeholder, in the input box and the transcript, and is sent in full", async () => {
  const { terminal, agent, all, live, shows, idle, exited } = await setup([{ text: "got it" }])
  const log = Array.from({ length: 30 }, (_, i) => `log line ${i}`).join("\n")
  terminal.send(`see \x1b[200~${log}\x1b[201~ please`)
  await waitFor(() => live().includes("see [pasted 30 lines #1] please"), "placeholder")
  expect(live()).not.toContain("log line 3")
  terminal.send("\r")
  await shows("got it")
  await idle()
  expect(userTexts(agent)).toEqual([`see ${log} please`])
  expect(all()).toContain("› see [pasted 30 lines #1] please")
  expect(all()).not.toContain("log line 3")
  terminal.send("\x03")
  await exited
})

/** A tool that asks for a review of a diff `lines` long. */
function reviewTool(lines: number) {
  const diff = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join("\n")
  return (api: Parameters<Parameters<ExtensionHost["load"]>[0]>[0]) => {
    api.registerTool(
      defineTool({
        name: "review",
        description: "",
        parameters: {},
        execute: async () =>
          textResult(String(await api.ui.reviewDiff("Merge the worktree?", diff, ["merge", "keep"]))),
      }),
    )
  }
}

test("a diff review taller than the terminal keeps its title, options and keys in view", async () => {
  const { host, terminal, live, idle, exited } = await setup(
    [{ toolCalls: [{ name: "review", args: {} }] }, { text: "reviewed" }],
    { rows: 14 },
  )
  await host.load(reviewTool(54), "reviewer")
  terminal.send("go\r")
  await waitFor(() => live().includes("? Merge the worktree?"), "review dialog")
  const rows = live().split("\n")
  expect(rows.some((l) => /… \d+ more lines …/.test(l))).toBe(true)
  expect(live()).toContain("+ line 1")
  expect(live()).toContain("+ line 54")
  expect(live()).toContain("❯ 1 merge")
  expect(live()).toContain("  2 keep")
  expect(live()).toContain("↑↓ move · enter choose · esc cancel")
  expect(live()).not.toContain("type to filter")
  // The running call that asked stays in view above it, and the frame fits the screen.
  expect(
    rows.some((l) => new RegExp(`^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] review +\\d+s {2}${localClock(Date.now())}$`).test(l)),
  ).toBe(true)
  expect(rows[0]).not.toContain("line")
  terminal.send("1")
  await idle()
  terminal.send("\x03")
  await exited
})

test("↑ on an empty editor recalls what was sent, and ↓ goes back to empty", async () => {
  const history = new PromptHistory()
  const { terminal, agent, live, shows, idle, exited } = await setup([{ text: "one" }, { text: "two" }], {
    promptHistory: history,
  })
  terminal.send("first message\r")
  await shows("one")
  await idle()
  expect(history.entries.map((e) => e.text)).toEqual(["first message"])
  terminal.send("\x1b[A")
  await waitFor(() => live().includes("› first message"), "recalled")
  terminal.send("\x1b[B")
  await waitFor(() => live().includes("Message Amira"), "empty again")
  terminal.send("\x1b[A\r")
  await shows("two")
  await idle()
  expect(userTexts(agent)).toEqual(["first message", "first message"])
  terminal.send("\x03")
  await exited
})

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: recalled skills still run and dollar-prefixed prose still sends`, async () => {
    const history = new PromptHistory()
    history.add(["$100 is the price"])
    history.add(["$deploy"])
    const { terminal, live, mock, shows, idle, exited } = await skillSetup(
      [{ text: "Deployed." }, { text: "Noted." }],
      { promptHistory: history, settings: { mode } },
    )
    try {
      terminal.send("\x1b[A\r")
      await shows("Deployed.")
      await idle()
      expect(mock.requests[0]!.messages[0]).toMatchObject({
        content: [{ type: "text", text: "SKILL deploy BODY " }],
      })
      terminal.send("\x1b[A\x1b[A")
      await waitFor(() => live().includes("› $100 is the price"), "recalled prose")
      terminal.send("\r")
      await shows("Noted.")
      await idle()
      expect(mock.requests[1]!.messages.at(-1)).toMatchObject({
        content: [{ type: "text", text: "$100 is the price" }],
      })
    } finally {
      terminal.send("\x03\x03")
      await exited
    }
  })

  test(`${mode}: Enter guards a recalled missing skill until its list is dismissed`, async () => {
    const history = new PromptHistory()
    history.add(["$removed-skill"])
    const { terminal, live, mock, shows, idle, exited } = await skillSetup([{ text: "Noted." }], {
      promptHistory: history,
      settings: { mode },
    })
    try {
      terminal.send("\x1b[A")
      await waitFor(() => live().includes("› $removed-skill"), "recalled skill")
      expect(live()).not.toContain("no skill matches")
      terminal.send("\r")
      await Bun.sleep(50)
      expect(mock.requests).toHaveLength(0)
      await waitFor(() => live().includes("no skill matches $removed-skill"), "missing skill guard")
      terminal.send("\x1b")
      await Bun.sleep(50)
      terminal.send("\r")
      await shows("Noted.")
      await idle()
      expect(mock.requests).toHaveLength(1)
      expect(mock.requests[0]!.messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "$removed-skill" }],
      })
    } finally {
      terminal.send("\x03\x03")
      await exited
    }
  })

  test(`${mode}: ↑/↓ walk past recalled commands, skills and @files without opening their lists`, async () => {
    const history = new PromptHistory()
    for (const t of ["look at @src", "oldest", "/status", "$deploy", "newest"]) history.add([t])
    const { terminal, live, exited } = await skillSetup([], {
      promptHistory: history,
      files: ["src/app.ts", "src/format.ts"],
      settings: { mode },
    })
    const UP = "\x1b[A"
    const DOWN = "\x1b[B"
    const shown = async (text: string, what: string) => {
      await waitFor(() => live().includes(`› ${text}`), what)
      await Bun.sleep(20)
      // No list opened for the recalled text.
      expect(live()).not.toContain("esc close")
    }
    for (const t of ["newest", "$deploy", "/status", "oldest", "look at @src"]) {
      terminal.send(UP)
      await shown(t, `${mode}: up to ${t}`)
    }
    for (const t of ["oldest", "/status", "$deploy", "newest"]) {
      terminal.send(DOWN)
      await shown(t, `${mode}: down to ${t}`)
    }
    terminal.send(DOWN)
    await waitFor(() => live().includes("Message Amira"), `${mode}: empty again`)
    // Once the recalled text is edited, its list opens as usual and takes ↑/↓.
    terminal.send(`${UP}${UP}${UP}`)
    await shown("/status", `${mode}: /status again`)
    terminal.send("\x7fs")
    await waitFor(() => live().includes("esc close"), `${mode}: the command list`)
    terminal.send(UP)
    await Bun.sleep(30)
    expect(live()).toContain("› /status")
    expect(live()).toContain("esc close")
    terminal.send("\x03\x03")
    await exited
  })
}

test("Enter runs a recalled command; Ctrl+R still puts a command in the editor with its list", async () => {
  const history = new PromptHistory()
  for (const t of ["/status", "newest"]) history.add([t])
  const { terminal, live, shows, exited } = await setup([], {
    promptHistory: history,
    commands: testCommands([]),
  })
  terminal.send("\x1b[A\x1b[A")
  await waitFor(() => live().includes("› /status"), "recalled")
  terminal.send("\r")
  await shows("STATUS OK")
  terminal.send("\x12stat")
  await waitFor(() => /│ › \/status +│/.test(live()) && live().includes("search history"), "match")
  terminal.send("\r")
  await waitFor(() => !live().includes("search history") && live().includes("esc close"), "the list")
  terminal.send("\x03\x03")
  await exited
})

test("messages queued together are sent as one turn but shown one by one", async () => {
  const { terminal, all, shows, idle, agent, exited } = await setup([
    { text: "first answer", delayMs: 40 },
    { text: "second answer" },
  ])
  terminal.send("start\r")
  await waitFor(() => agent.status === "working", "working")
  terminal.send(`one${ALT_ENTER}`)
  terminal.send(`two${ALT_ENTER}`)
  await shows("queued › two")
  await shows("second answer")
  await idle()
  expect(all()).toMatch(/› one +\d{2}:\d{2}\n\n\n\n {2}› two +\d{2}:\d{2}/)
  expect(all()).not.toContain("  two")
  const prompts = agent.messages.filter((m) => m.role === "user")
  expect(prompts.length).toBe(2)
  terminal.send("\x03")
  await exited
})

test("Ctrl+R searches the history; Enter keeps the match in the editor to send or edit", async () => {
  const history = new PromptHistory()
  for (const t of ["deploy to staging", "run the tests", "deploy to prod"]) history.add([t])
  const { terminal, agent, live, shows, idle, exited } = await setup([{ text: "on it" }], {
    promptHistory: history,
  })
  terminal.send("\x12")
  await waitFor(() => live().includes("search history"), "search line")
  expect(live()).toContain("esc cancel")
  terminal.send("deploy")
  await waitFor(() => live().includes("› deploy to prod"), "newest match")
  expect(live()).toContain("1 of 2")
  terminal.send("\x12")
  await waitFor(() => live().includes("› deploy to staging"), "older match")
  terminal.send("\r")
  await waitFor(() => !live().includes("search history"), "search closed")
  expect(live()).toContain("› deploy to staging")
  terminal.send("\r")
  await shows("on it")
  await idle()
  expect(userTexts(agent)).toEqual(["deploy to staging"])
  terminal.send("\x03")
  await exited
})

test("Esc leaves the history search with the draft back", async () => {
  const history = new PromptHistory()
  history.add(["old prompt"])
  const { terminal, live, exited } = await setup([], { promptHistory: history })
  terminal.send("my draft\x12old")
  await waitFor(() => live().includes("› old prompt"), "match")
  terminal.send("\x1b")
  await waitFor(() => live().includes("› my draft"), "draft back")
  expect(live()).not.toContain("search history")
  terminal.send("\x03\x03")
  await exited
})

test("Ctrl+L clears the screen and draws the latest transcript and the live region again", async () => {
  const { terminal, screen, live, shows, idle, exited } = await setup([{ text: "the answer" }])
  terminal.send("hello\r")
  await shows("the answer")
  await idle()
  terminal.send("draft")
  await waitFor(() => live().includes("draft"), "draft")
  // Some other program wrote over the screen.
  screen.write("\x1b[1;1HGARBAGE GARBAGE\r\nMORE GARBAGE")
  terminal.send("\x0c")
  await waitFor(() => !live().includes("GARBAGE"), "redrawn")
  expect(live()).toContain("› hello")
  expect(live()).toContain("the answer")
  expect(live()).toContain("› draft")
  expect(screen.lines[1]).toContain("Amira")
  terminal.send("\x03\x03")
  await exited
})

test("typing @ offers project files; Tab inserts the path and the message keeps it", async () => {
  const { terminal, agent, live, shows, idle, exited } = await setup([{ text: "read it" }], {
    files: ["src/app.ts", "src/format.ts", "README.md"],
  })
  terminal.send("look at @form")
  await waitFor(() => live().includes("❯ src/format.ts"), "file list")
  expect(live()).toContain("tab/enter insert")
  // Like the command list, it opens below the input box, in place of the status bar.
  const rows = live().split("\n")
  expect(rows.findIndex((l) => l.includes("❯ src/format.ts"))).toBeGreaterThan(
    rows.findIndex((l) => l.startsWith("╰")),
  )
  terminal.send("\t")
  await waitFor(() => live().includes("› look at @src/format.ts"), "inserted")
  expect(live()).not.toContain("tab/enter insert")
  terminal.send("please\r")
  await shows("read it")
  await idle()
  expect(userTexts(agent)).toEqual(["look at @src/format.ts please"])
  terminal.send("\x03")
  await exited
})
test("typing @ while the project is still listed shows a status row at once, then the files as they come", async () => {
  let emit!: (paths: string[]) => void
  let finish!: () => void
  const fileSource = new FileIndex("/work/proj", {
    list: (_cwd, e) => {
      emit = e
      return new Promise<void>((r) => {
        finish = r
      })
    },
  })
  const { terminal, live, exited } = await setup([], { fileSource, cols: 60 })
  terminal.send("see @app")
  await waitFor(() => /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] indexing… 0 files$/m.test(live()), "status row")
  // The input box took every key; the row is where the list goes, below the box.
  expect(live()).toContain("│ › see @app")
  const rows = live().split("\n")
  expect(rows.findIndex((l) => l.includes("indexing…"))).toBeGreaterThan(
    rows.findIndex((l) => l.startsWith("╰")),
  )
  emit(Array.from({ length: 12_345 }, (_, i) => `gen/f${i}.ts`).concat("src/app.ts"))
  await waitFor(
    () => /❯ src\/app\.ts/.test(live()) && live().includes("indexing… 12,346 files"),
    "first files",
  )
  finish()
  await waitFor(() => !live().includes("indexing…"), "indexed")
  expect(live()).toMatch(/❯ src\/app\.ts/)
  terminal.send("\t")
  await waitFor(() => live().includes("› see @src/app.ts"), "inserted")
  terminal.send("\x03\x03")
  await exited
})

for (const mode of ["fullscreen", "inline"] as const) {
  test(`the terminal title uses the session title instead of the folder in ${mode} mode`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-terminal-title-"))
    const session = SessionStore.create({ cwd: "/work/proj", dir })
    session.appendMessage(userMessage("history"))
    session.rename("Database repair")
    try {
      const { terminal, screen, bus, agent, shows, idle, exited } = await setup(
        [{ text: "done", delayMs: 20 }],
        { env: { WT_SESSION: "1" }, session, settings: { mode } },
      )
      bus.emit("workspace.changed", { cwd: "/work/proj", branch: "main" }, { sessionId: agent.sessionId })
      await waitFor(
        () => screen.oscs.includes("0;Amira · Database repair"),
        "session title without duplicate workspace details",
      )
      terminal.send("go\r")
      await shows("done")
      await idle()
      const oscs = screen.oscs
      expect(oscs).toContain("0;● Amira · Database repair")
      expect(oscs).toContain("9;4;3;0")
      expect(oscs.filter((o) => o.startsWith("9;4;")).at(-1)).toBe("9;4;0;0")
      expect(oscs.filter((o) => o.startsWith("0;")).at(-1)).toBe("0;Amira · Database repair")
      terminal.send("\x03")
      await exited
      // The title is handed back: the terminal's own, or the one saved on the title stack.
      expect(screen.oscs.at(-1)).toBe("0;")
      expect(terminal.output).toContain("\x1b]0;\x07\x1b[23;0t")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("outside Windows Terminal and friends no progress is sent; settings turn title and bell off", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([{ text: "done" }], {
    env: { TERM_PROGRAM: "iTerm.app" },
    settings: { title: false, bell: false, notify: "off" },
  })
  terminal.send("\x1b[Ogo\r")
  await shows("done")
  await idle()
  terminal.send("\x03")
  await exited
  expect(screen.oscs).toEqual([])
  expect(screen.bells).toBe(0)
  // Focus reports stay on without the bell: extensions get them as ui.focus.
  expect(terminal.output).toContain("\x1b[?1004h")
})

test("the bell rings when a turn ends in the background; focus reports never reach the editor", async () => {
  const { terminal, screen, live, shows, idle, exited } = await setup([{ text: "one" }, { text: "two" }])
  expect(terminal.output).toContain("\x1b[?1004h")
  terminal.send("\x1b[Ifirst\r")
  await shows("one")
  await idle()
  expect(screen.bells).toBe(0)
  terminal.send("\x1b[Osecond\r")
  await shows("two")
  await idle()
  expect(screen.bells).toBe(1)
  expect(live()).not.toContain("[O")
  expect(live()).not.toContain("[I")
  terminal.send("\x03")
  await exited
})

test("focus reports reach extensions as ui.focus, once per change", async () => {
  const { terminal, agent, exited } = await setup([])
  const seen: boolean[] = []
  agent.bus.subscribe((e) => void (e.type === "ui.focus" && seen.push(e.data.focused)), {
    types: ["ui.focus"],
  })
  terminal.send("\x1b[O\x1b[O\x1b[I\x1b[I\x1b[O")
  await agent.bus.flush()
  expect(seen).toEqual([false, true, false])
  terminal.send("\x03")
  await exited
})

test("a narrow hint drops whole items instead of cutting one", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([{ text: "slow answer", delayMs: 40 }], {
    cols: 40,
  })
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  // Stop and the first base key stay whole; the contextual submit and queue keys give way.
  await waitFor(() => /^ shift\+tab mode {2}│ {2}esc stop$/m.test(live()), "working hint")
  expect(live()).not.toContain(" queue")
  expect(live()).not.toContain("enter steer")
  expect(live()).not.toContain("sto…")
  await shows("slow answer")
  await idle()
  await waitFor(() => /^ shift\+tab mode {2}│ {2}ctrl\+o detail$/m.test(live()), "idle hint")
  terminal.send("\x03")
  await exited
})

test("keybindings replace the default keys, and the hints name them", async () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    queue: ["ctrl+t"],
    cancel: ["ctrl+x"],
    newline: ["ctrl+j"],
    interrupt: ["ctrl+g"],
    help: ["f1"],
  })
  const { terminal, live, agent, shows, idle, exited } = await setup(
    [{ text: "first", delayMs: 40 }, { text: "later" }],
    { keybindings: keys, cols: 100 },
  )
  await waitFor(() => /^ shift\+tab mode {2}│ {2}ctrl\+o detail {2}│ {2}f1 keys$/m.test(live()), "idle hint")
  terminal.send("go")
  await waitFor(
    () => /^ shift\+tab mode {2}│ {2}ctrl\+o detail {2}│ {2}f1 keys {2}│ {2}ctrl\+j newline$/m.test(live()),
    "hint with text",
  )
  terminal.send("\r")
  await waitFor(() => agent.status === "working", "working")
  await waitFor(
    () =>
      /^ shift\+tab mode {2}│ {2}ctrl\+g stop {2}│ {2}ctrl\+o detail {2}│ {2}f1 keys {2}│ {2}enter steer {2}│ {2}ctrl\+t queue$/m.test(
        live(),
      ),
    "working hint",
  )
  terminal.send("next\x14")
  await shows("queued › next")
  await shows("later")
  await idle()
  // Ctrl+C is not bound any more; Ctrl+X quits.
  terminal.send("\x03")
  await Bun.sleep(30)
  terminal.send("\x18")
  expect(await exited).toBe(0)
})

test("links in a reply are clickable where the UI's environment says the terminal supports it", async () => {
  for (const env of [{ WT_SESSION: "1" }, {}]) {
    const { terminal, screen, shows, idle, exited } = await setup(
      [{ text: "See [the docs](https://example.com/docs) now." }],
      { env },
    )
    terminal.send("go\r")
    await shows("now.")
    await idle()
    const linked = screen.oscs.some((o) => o.startsWith("8;") && o.endsWith("https://example.com/docs"))
    expect(linked).toBe("WT_SESSION" in env)
    terminal.send("\x03")
    await exited
  }
})

test("history, the history search, the file list and Ctrl+O take their keys from the keybindings too", async () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "history.search": ["ctrl+f"],
    "search.cancel": ["ctrl+x"],
    "popup.close": ["ctrl+x"],
    "tool-output": ["ctrl+t"],
    "history.prev": ["ctrl+p"],
  })
  const promptHistory = new PromptHistory()
  promptHistory.add(["old prompt"])
  const { terminal, live, exited } = await setup([], {
    keybindings: keys,
    promptHistory,
    files: ["src/app.ts"],
    tuiCommands: true,
    cols: 80,
  })
  // The default Ctrl+R and ↑ are not bound any more.
  terminal.send("\x12\x1b[A")
  await Bun.sleep(30)
  expect(live()).not.toContain("search history")
  expect(live()).not.toContain("› old prompt")
  terminal.send("\x06")
  await waitFor(() => live().includes("search history"), "search line")
  expect(live()).toContain("enter accept · ctrl+r older · ctrl+x cancel")
  terminal.send("\x18")
  await waitFor(() => !live().includes("search history"), "search closed")
  terminal.send("\x10")
  await waitFor(() => live().includes("› old prompt"), "recalled with Ctrl+P")
  terminal.send("\x03")
  terminal.send("@src")
  // The directory named as typed first, then its file.
  await waitFor(() => live().includes("❯ src/\n  src/app.ts"), "file list")
  expect(live()).toContain("tab/enter insert · ctrl+x close")
  terminal.send("\x18")
  await waitFor(() => !live().includes("src/app.ts"), "file list closed")
  terminal.send("\x03\x14")
  await waitFor(() => live().includes("Tool output: full"), "tool output note")
  expect(live()).toContain("ctrl+t cycles")
  terminal.send("\x03")
  await exited
})

test("with tui.reflow off, a narrower terminal does not move up past the live region", async () => {
  for (const reflow of ["on", "off"] as const) {
    const { terminal, all, exited } = await setup([], { settings: { reflow }, cols: 60, rows: 20 })
    await waitFor(() => all().includes("Message Amira"), "input box")
    terminal.clearWrites()
    terminal.setSize(40, 20)
    await waitFor(() => terminal.writes.length > 0, "a frame")
    // Above the editor are the box top, inline header and blank row. Reflow adds one
    // row for each full-width header and border; without reflow all three stay one row.
    expect(terminal.writes[0]!).toContain(`\r\x1b[${reflow === "on" ? 5 : 3}A\x1b[J`)
    terminal.send("\x03")
    await exited
  }
})

/**
 * A stand-in for the images extension's provider: `size` says what each image is (undefined:
 * it cannot be shown), encoding makes up data of the fitted size.
 */

test("without built-ins the TUI leaves terminal title, progress and bell untouched", async () => {
  const s = await setup([{ text: "done" }], { noBuiltins: true, env: { WT_SESSION: "1" } })
  s.terminal.send("\x1b[Ogo\r")
  await s.shows("done")
  await s.idle()
  s.terminal.send("\x03")
  expect(await s.exited).toBe(0)
  expect(s.screen.oscs).toEqual([])
  expect(s.screen.bells).toBe(0)
  expect(s.terminal.output).not.toContain("\x1b[22;0t")
})

test("a hidden foreground question never rings and visibility changes retain paused progress", async () => {
  const s = await setup([], { env: { WT_SESSION: "1" } })
  s.terminal.send("\x1b[I?")
  await waitFor(() => s.live().includes("? Keys"), "key reference")
  const answer = s.host.ui.api("test").confirm("Hidden question", "Proceed?")
  await s.bus.flush()
  expect(s.screen.bells).toBe(0)
  expect(s.screen.oscs.filter((o) => o.startsWith("9;4;")).at(-1)).toBe("9;4;4;100")
  s.terminal.send("\x1b[27u")
  await waitFor(() => s.live().includes("Hidden question"), "visible question")
  await s.bus.flush()
  expect(s.screen.bells).toBe(0)
  s.terminal.send("\x1b[27u")
  await answer
  await s.bus.flush()
  expect(s.screen.oscs.filter((o) => o.startsWith("9;4;")).at(-1)).toBe("9;4;0;0")
  s.terminal.send("\x03\x03")
  expect(await s.exited).toBe(0)
})
