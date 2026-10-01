import { expect, test } from "bun:test"
import { type AnyEvent, defineTool, type Message, textResult } from "@amira/api"
import { plain } from "../../tui-kit/test/context.ts"
import {
  activityLabel,
  lastReasoningLine,
  pendingMessageRows,
  retryLabel,
  statusRetryLabel,
  tildePath,
} from "../src/app.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import {
  ALT_ENTER,
  exchange,
  lastUserText,
  parallel,
  QUEUE_HINT,
  setup,
  testCommands,
  transcriptChecker,
  userTexts,
  waitFor,
} from "./app-harness.ts"

test("a conversation: user message, tool call and reply end up in the transcript", async () => {
  const { terminal, all, shows, idle, exited } = await setup([
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    { text: "The file has three lines." },
  ])
  expect(all()).toContain("mock/m1")
  terminal.send("what is in a.ts?\r")
  await shows("The file has three lines.")
  await idle()
  const text = all()
  expect(text).toContain("› what is in a.ts?")
  expect(text).toContain("● read a.ts")
  expect(text).toContain("└ contents of a.ts (+2 lines)")
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("The file has three lines."))
  // One blank line between blocks, and the reply indented so it reads apart from the rest. The
  // user's message is on a band with a row of it above and below (blank on this screen).
  expect(text).toContain(
    [
      "Amira · mock/m1 · /work/proj",
      // Where to start, right under the banner.
      "@ files · ? keys",
      "",
      "",
      "› what is in a.ts?",
      "",
      "",
      "● read a.ts",
      "  └ contents of a.ts (+2 lines)",
      "",
      "  The file has three lines.",
      "",
      "╭",
    ].join("\n"),
  )
  terminal.send("\x03")
  expect(await exited).toBe(0)
  expect(terminal.isRaw).toBe(false)
})

test("without providers the UI starts with a welcome card; a message sent keeps its text in the input", async () => {
  const notice = "No providers configured — add one with /provider add, then pick a model with /model."
  const { terminal, all, live, shows, agent, exited, mock } = await setup([], {
    noModel: "none",
    notice,
    cols: 100,
  })
  // The card says what the notice would, as steps.
  await shows("Welcome to Amira. Three steps to a first message:")
  expect(all()).toContain("1. Add a provider: /provider add")
  expect(all()).toContain("2. Pick one of its models: /model")
  expect(all()).toContain("3. Ask away: @ mentions files, /help lists the commands and keys")
  expect(all()).not.toContain(notice)
  expect(all()).toContain("Amira · (no model) · /work/proj")
  await waitFor(() => live().includes("╰─ (no model) ─"), "the status's (no model)")
  terminal.send("hello\r")
  await shows("No providers configured: add one with /provider add, then pick a model with /model.")
  // Not sent: the message waits in the input for a model.
  expect(live()).toContain("│ › hello")
  expect(agent.messages).toEqual([])
  expect(mock.requests).toHaveLength(0)
  terminal.send("\x03")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("with providers but no model picked, a message says to pick one and stays in the input", async () => {
  const { terminal, live, shows, exited } = await setup([], {
    noModel: "unpicked",
    notice: 'No model selected — pick one with /model, or set "model" in settings.json.',
  })
  await shows("No model selected — pick one with /model")
  terminal.send("hello\r")
  await shows("No model selected: pick one with /model.")
  expect(live()).toContain("› hello")
  terminal.send("\x03")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("a banner wider than the terminal wraps at a word, not where the terminal cuts it", async () => {
  const { terminal, all, exited } = await setup([], { cols: 24 })
  expect(all()).toContain("Amira · mock/m1 ·\n/work/proj")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("a home directory in the banner reads as ~", () => {
  expect(tildePath("/home/ada/proj", { HOME: "/home/ada" })).toBe("~/proj")
  expect(tildePath("/home/ada", { HOME: "/home/ada/" })).toBe("~")
  expect(tildePath("/home/adam/proj", { HOME: "/home/ada" })).toBe("/home/adam/proj")
  expect(tildePath("/work/proj", { HOME: "/home/ada" })).toBe("/work/proj")
  // Windows: the profile is the home, whatever HOME a shell set; the drive's case does not matter.
  const win = { USERPROFILE: "C:\\Users\\Ada", HOME: "/c/Users/Ada" }
  expect(tildePath("c:\\Users\\Ada\\proj", win, "win32")).toBe("~\\proj")
  expect(tildePath("C:\\Users\\Adam\\proj", win, "win32")).toBe("C:\\Users\\Adam\\proj")
})

test("a startup notice about something else shows under the welcome card", async () => {
  const { terminal, all, shows, exited } = await setup([], {
    noModel: "none",
    notice: "settings.json could not be read",
    cols: 100,
    // The session says there are no providers; the notice is about something else.
    commands: [],
    control: { providers: () => [] },
  })
  await shows("Welcome to Amira. Three steps to a first message:")
  await shows("settings.json could not be read")
  expect(all()).not.toContain("No providers configured")
  terminal.send("\x03")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("parallel tool calls reach the transcript in call order, whichever finishes first", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    {
      toolCalls: [
        { name: "slow", args: { path: "a.ts" } },
        { name: "fast", args: { path: "b.ts" } },
      ],
    },
    { text: "done" },
  ])
  let release!: () => void
  let fastDone = false
  agent.tools.register(
    defineTool({
      name: "slow",
      ...parallel,
      execute: () =>
        new Promise((r) => {
          release = () => r(textResult("slow result"))
        }),
    }),
    "test",
  )
  agent.tools.register(
    defineTool({
      name: "fast",
      ...parallel,
      execute: async () => {
        fastDone = true
        return textResult("fast result")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  // fast finished first: it waits below slow in the live region, not in the transcript yet.
  await waitFor(() => fastDone && /● slow a\.ts .*\n● fast b\.ts$/m.test(live()), "fast held under slow")
  await Bun.sleep(30)
  expect(all()).not.toContain("fast result")
  release()
  await shows("done")
  await idle()
  expect(all()).toContain(
    ["● slow a.ts", "  └ slow result", "● fast b.ts", "  └ fast result", "", "  done"].join("\n"),
  )
  terminal.send("\x03")
  await exited
})

test("a running tool shows the last lines of its output live, and only its result once done", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "stream", args: { command: "make" } }] },
    { text: "built" },
  ])
  let release!: () => void
  agent.tools.register(
    defineTool({
      name: "stream",
      ...parallel,
      execute: async (_p, ctx) => {
        ctx.update(textResult("l1\nl2\nl3\nl4\nl5\n"))
        await new Promise<void>((r) => {
          release = r
        })
        return textResult("ok")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("│ l5"), "live output")
  expect(live()).toContain("  │ l3\n  │ l4\n  │ l5")
  expect(live()).not.toContain("│ l2")
  release()
  await shows("built")
  await idle()
  expect(all()).toContain("● stream make\n  └ ok")
  expect(all()).not.toContain("│ l5")
  terminal.send("\x03")
  await exited
})

test("many calls at once take at most half the screen: output first, then the first calls give way", async () => {
  const calls = Array.from({ length: 8 }, (_, i) => ({ name: "stream", args: { command: `job${i + 1}` } }))
  const { terminal, live, shows, idle, exited, agent } = await setup(
    [{ toolCalls: calls }, { text: "all built" }],
    {
      rows: 14,
    },
  )
  const releases: (() => void)[] = []
  agent.tools.register(
    defineTool({
      name: "stream",
      ...parallel,
      execute: async (_p, ctx) => {
        ctx.update(textResult("l1\nl2\n"))
        await new Promise<void>((r) => releases.push(r))
        return textResult("ok")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => releases.length === 8 && live().includes("job8"), "all running")
  // 14 rows: at most 7 for the calls, their output dropped, the first three counted.
  expect(live()).not.toContain("│ l2")
  expect(live()).toContain("… 3 earlier calls")
  expect(live()).not.toContain("job3 ")
  expect(live()).toContain("job4")
  for (const r of releases) r()
  await shows("all built")
  await idle()
  terminal.send("\x03")
  await exited
})

test("Esc interrupting a running tool marks it interrupted, muted, not failed", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "hang", args: { command: "sleep 100" } }] },
  ])
  agent.tools.register(
    defineTool({
      name: "hang",
      ...parallel,
      execute: (_p, ctx) =>
        new Promise((r) =>
          ctx.signal.addEventListener("abort", () => r(textResult("Command was aborted.", true))),
        ),
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("● hang sleep 100"), "running")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  await idle()
  // What it printed before it was stopped stays under it.
  expect(all()).toContain("⊘ hang sleep 100\n  └ interrupted\n    Command was aborted.\n\n⊘ Interrupted")
  expect(all()).not.toContain("✗")
  terminal.send("\x03")
  await exited
})

test("failures show their output cut to 8 lines; Ctrl+O shows all of later ones and says so", async () => {
  const out = Array.from({ length: 20 }, (_, i) => `out ${i + 1}`).join("\n")
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "fail", args: {} }] },
    { text: "one" },
    { toolCalls: [{ name: "fail", args: {} }] },
    { text: "two" },
  ])
  agent.tools.register(
    defineTool({ name: "fail", ...parallel, execute: async () => textResult(`bad\n${out}`, true) }),
    "test",
  )
  terminal.send("go\r")
  await shows("one")
  await idle()
  expect(all()).toContain("✗ fail\n  └ bad (+20 lines)\n    out 1\n")
  expect(all()).toContain("    … 13 more lines\n")
  expect(all()).not.toContain("out 10")
  terminal.send("\x0f")
  await waitFor(() => live().includes("Tool output: full (applies to tool results from now on"), "hint")
  terminal.send("again\r")
  await shows("two")
  await idle()
  // The first result stays as it was committed; the second one is complete.
  expect(all().split("    out 10\n").length - 1).toBe(1)
  expect(all().split("… 13 more lines").length - 1).toBe(1)
  terminal.send("\x03")
  await exited
})

test("/verbose sets the tool output level, printed under the command", async () => {
  const { terminal, all, shows, exited } = await setup([], { commands: testCommands([]), tuiCommands: true })
  terminal.send("/verbose collapsed\r")
  await shows("Tool output: collapsed")
  // Wrapped to the width, hanging under the result mark, below the echo's band.
  expect(all()).toContain(
    "› /verbose collapsed\n\n  └ Tool output: collapsed (applies to tool results from now\n    on; Ctrl+O cycles)",
  )
  terminal.send("/verbose loud\r")
  await shows('Unknown level "loud"')
  terminal.send("\x03")
  await exited
})

test("the built-in presenters: an edit shows its diff with line numbers", async () => {
  const { terminal, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "edit", args: { path: "src/a.ts", old_string: "old", new_string: "new" } }] },
      { text: "ok" },
    ],
    { presenters: true },
  )
  agent.tools.register(
    defineTool({
      name: "edit",
      ...parallel,
      execute: async () => ({
        content: [{ type: "text", text: "Edited src/a.ts: replaced 1 occurrence" }],
        details: {
          path: "/work/proj/src/a.ts",
          replacements: 1,
          added: 1,
          removed: 1,
          hunks: [{ oldStart: 11, oldLines: 2, newStart: 11, newLines: 2, lines: [" keep", "-old", "+new"] }],
        },
      }),
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("ok")
  await idle()
  expect(all()).toContain(
    ["● edit src/a.ts", "  └ +1 -1", "    11   keep", "    12 - old", "    12 + new", "", "  ok"].join("\n"),
  )
  terminal.send("\x03")
  await exited
})

test("successful reads in a row, over steps too, go to the scrollback as one Explored row", async () => {
  const { terminal, all, shows, idle, exited } = await setup(
    [
      {
        toolCalls: [
          { name: "read", args: { path: "a.ts" } },
          { name: "read", args: { path: "b.ts" } },
        ],
      },
      { toolCalls: [{ name: "read", args: { path: "c.ts" } }] },
      { text: "done" },
    ],
    { presenters: true },
  )
  terminal.send("go\r")
  await shows("done")
  await idle()
  expect(all()).toContain("● Explored · Read a.ts, b.ts, c.ts\n\n  done")
  expect(all()).not.toContain("● read a.ts")
  terminal.send("\x03")
  await exited
})

test("a resumed session shows its thinking folded and marks a reply that was interrupted", async () => {
  const { terminal, all, exited } = await setup([], {
    history: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "let me see" },
          { type: "text", text: "Half an ans" },
        ],
        model: { provider: "mock", model: "m1" },
        stopReason: "aborted",
      },
    ],
  })
  await waitFor(() => all().includes("⊘ Interrupted"), "history")
  expect(all()).toContain("› go\n\n\n∴ Thought\n\n  Half an ans\n\n⊘ Interrupted")
  terminal.send("\x03")
  await exited
})

test("a resumed session shows a boundary with its id, then its history like the live transcript", async () => {
  const { terminal, all, agent, exited } = await setup([], {
    presenters: true,
    history: [
      { role: "user", content: [{ type: "text", text: "count" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "glob", args: { pattern: "*.ts" } }],
        model: { provider: "mock", model: "m1" },
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "glob",
        content: [{ type: "text", text: "a.ts\nb.ts" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Two." }],
        model: { provider: "mock", model: "m1" },
      },
    ],
  })
  await waitFor(() => all().includes("── resumed"), "history")
  expect(all()).toContain(`── resumed ${agent.sessionId} ${"─".repeat(38)}\n\n\n› count`)
  expect(all()).toContain(["› count", "", "", "● glob *.ts", "  └ 2 files", "", "  Two."].join("\n"))
  terminal.send("\x03")
  await exited
})

test("the activity line shows what the turn does, its time and output tokens; the hint how to interrupt", async () => {
  const { terminal, live, idle, exited } = await setup([{ text: "x".repeat(200), delayMs: 20 }])
  terminal.send("go\r")
  await waitFor(() => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] working · 0s · ↓ \d+ tokens$/m.test(live()), "activity")
  expect(live()).toContain(`Enter steer · ${QUEUE_HINT} queue · Esc interrupt`)
  await idle()
  expect(live()).not.toContain("Esc interrupt")
  terminal.send("\x03")
  await exited
})

test("while tools run the activity line names them and keeps its spinner and time", async () => {
  const { terminal, live, idle, exited, agent } = await setup(
    [
      {
        toolCalls: [
          { name: "slowa", args: {} },
          { name: "slowb", args: {} },
        ],
      },
      { text: "ok" },
    ],
    { cols: 80 },
  )
  const release: Record<string, () => void> = {}
  for (const name of ["slowa", "slowb"]) {
    agent.tools.register(
      defineTool({
        name,
        description: "",
        parameters: {},
        concurrency: "parallel",
        execute: () =>
          new Promise((r) => {
            release[name] = () => r(textResult("done"))
          }),
      }),
      "test",
    )
  }
  const activity = (label: string) => new RegExp(`^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${label} · \\d+s( · ↓ \\d+ tokens)?$`, "m")
  terminal.send("go\r")
  await waitFor(() => activity("2 tools running").test(live()), "two tools")
  // The rows keep their own spinners.
  expect(live()).toMatch(/● slowa +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+s/)
  release.slowb!()
  await waitFor(() => activity("1 tool running").test(live()), "one tool left")
  release.slowa!()
  await idle()
  expect(live()).not.toContain("Esc interrupt")
  terminal.send("\x03")
  await exited
})

test("the activity label names the most specific activity", () => {
  const base = { compacting: false, running: [] as string[], preparing: undefined, thinking: false }
  expect(activityLabel(base)).toBe("working")
  expect(activityLabel({ ...base, thinking: true })).toBe("thinking")
  expect(activityLabel({ ...base, preparing: "bash" })).toBe("preparing bash")
  // Running tools are counted: their own rows name them.
  expect(activityLabel({ ...base, running: ["bash"], thinking: true })).toBe("1 tool running")
  expect(activityLabel({ ...base, running: ["bash", "read", "grep"] })).toBe("3 tools running")
  expect(activityLabel({ ...base, compacting: true, running: ["bash"] })).toBe("compacting the conversation")
  expect(activityLabel({ ...base, compacting: true, onServer: true, running: [] })).toBe(
    "compacting on the server",
  )
  const retry = { attempt: 2, maxRetries: 3, status: 429, kind: "rate", at: Date.now() + 5500 }
  expect(activityLabel({ ...base, running: ["bash"], retry })).toBe("retrying in 6s (2/3) · 429")
  expect(retryLabel({ ...retry, status: undefined, at: 0 }, 1000)).toBe("retrying in 0s (2/3) · rate")
  expect(activityLabel({ ...base, preparing: "write", waiting: true })).toBe("waiting for you")
  expect(activityLabel({ ...base, thinking: true, retrying: "retrying (2/3)" })).toBe("retrying (2/3)")
})

test("a failed model request reads as one line and the next step; the raw answer stays folded", async () => {
  const raw = `HTTP 401: {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}`
  const { terminal, all, shows, idle, exited } = await setup([{ error: { message: raw, status: 401 } }], {
    cols: 80,
  })
  terminal.send("hi\r")
  await shows("The API key was rejected by the provider (HTTP 401)")
  await idle()
  expect(all()).toContain("Set a new key with /provider key mock")
  expect(all()).not.toContain("invalid_api_key")
  terminal.send("\x03")
  await exited
})

test("while a failed request waits to be sent again, the activity line says so", async () => {
  const { terminal, live, shows, idle, exited } = await setup([
    { error: { message: "HTTP 429: slow down", status: 429, retryable: true } },
    { text: "got through" },
  ])
  terminal.send("hi\r")
  await waitFor(() => /retrying in 1s \(1\/3\) · 429/.test(live()), "the retry line")
  await shows("got through")
  await idle()
  expect(live()).not.toContain("retrying")
  terminal.send("\x03")
  await exited
})

test("a retry reads as the status says it, when and why if the event tells", () => {
  expect(statusRetryLabel({ reason: "retrying (2/3)" })).toBe("retrying (2/3)")
  expect(statusRetryLabel({ reason: "compacting" })).toBeUndefined()
  expect(statusRetryLabel({})).toBeUndefined()
  expect(statusRetryLabel({ retry: { attempt: 2, maxRetries: 3, delayMs: 5200, status: 429 } })).toBe(
    "retrying in 6s (2/3) · 429",
  )
  expect(statusRetryLabel({ reason: "retrying (1/3)", retry: { attempt: 1 } })).toBe("retrying (1)")
})

test("the activity line shows the last line of the reasoning while the model thinks", async () => {
  let release!: () => void
  const until = new Promise<void>((r) => {
    release = r
  })
  const { terminal, live, idle, exited } = await setup(
    [{ thinking: "First, the plan.\nThen look at   a.ts\n\n", text: "done", hold: { chunks: 0, until } }],
    { cols: 100 },
  )
  terminal.send("go\r")
  await waitFor(
    () => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking · \d+s · ↓ \d+ tokens · Then look at a\.ts$/m.test(live()),
    "the reasoning",
  )
  release()
  await idle()
  expect(live()).not.toContain("Then look at")
  terminal.send("\x03")
  await exited
  expect(lastReasoningLine("")).toBe("")
  expect(lastReasoningLine("a\n  b  c \n")).toBe("b c")
})

test("a message sent during /compact counts its own time and tokens, not the last turn's", async () => {
  const said = (text: string): Message[] => [
    { role: "user", content: [{ type: "text", text }] },
    {
      role: "assistant",
      content: [{ type: "text", text: `re ${text}` }],
      model: { provider: "mock", model: "m1" },
    },
  ]
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { text: "first answer", usage: { input: 10, output: 4321 } },
      { text: "SUMMARY ".repeat(40), delayMs: 10 },
      { text: "second answer" },
    ],
    { cols: 80, history: [...said("a"), ...said("b")] },
  )
  terminal.send("q1\r")
  await shows("first answer")
  await idle()
  const compacted = agent.compact()
  await waitFor(() => live().includes("compacting the conversation"), "compacting")
  terminal.send("q2\r")
  await waitFor(() => /› q2|Enter steer/.test(live()), "sent")
  // The prompt waits for the compaction; its activity line starts from zero meanwhile.
  expect(live()).toMatch(/compacting the conversation · 0s$/m)
  expect(live()).toContain("Esc interrupt")
  expect(live()).not.toContain("↓")
  expect(await compacted).toBe(true)
  await shows("second answer")
  await idle()
  expect(all()).toContain("Compacted")
  terminal.send("\x03")
  await exited
})

/** A user message and its reply, for histories. */
test("an automatic compaction's notice says it passed the threshold, and how far", async () => {
  const { terminal, all, shows, idle, exited } = await setup(
    [
      // 105k of the default 128k window: the next call compacts first.
      { text: "first answer", usage: { input: 105_000 } },
      { text: "SUMMARY" },
      { text: "second answer" },
    ],
    { cols: 120, history: [...exchange("a"), ...exchange("b")] },
  )
  terminal.send("q1\r")
  await shows("first answer")
  await idle()
  terminal.send("q2\r")
  await shows("second answer")
  await idle()
  expect(all()).toMatch(
    /Compacted automatically at 82% of 128k: 4 older messages into a summary \(105k → ~\d+k tokens\)\./,
  )
  terminal.send("\x03")
  await exited
})

test("a resumed compaction's summary line says why it happened", async () => {
  const { terminal, all, shows, exited } = await setup([{ text: "Fixed the parser." }], {
    cols: 100,
    history: [...exchange("a"), ...exchange("b"), ...exchange("c")],
    prepare: (agent) => agent.compact(),
  })
  await shows("▸ Compacted (you asked) · summary of earlier messages · 1 line")
  expect(all()).not.toContain("Compacted summary of earlier messages")
  terminal.send("\x03")
  await exited
})

test("Esc interrupts a running turn, keeps the partial text and sends queued messages after", async () => {
  const { terminal, all, shows, idle, agent, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "second answer" },
  ])
  terminal.send("first\r")
  await waitFor(() => agent.status === "working", "working")
  await shows("01234567")
  terminal.send(`follow up${ALT_ENTER}`)
  await shows("queued › follow up")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  await shows("second answer")
  await idle()
  const text = all()
  expect(text).toContain("› follow up")
  const partial = agent.messages.find((m) => m.role === "assistant")
  const kept =
    partial?.role === "assistant" && partial.content[0]?.type === "text" ? partial.content[0].text : ""
  expect(kept.length).toBeGreaterThan(0)
  expect(text).toContain(kept)
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("the status bar shows items from the status extension", async () => {
  const { live, terminal, exited } = await setup([])
  await waitFor(() => live().includes("mock/m1") && live().includes("proj"), "status bar")
  terminal.send("\x03")
  await exited
})

test("Ctrl+C clears a non-empty editor before quitting; Ctrl+D quits on an empty editor", async () => {
  const { terminal, live, exited } = await setup([])
  terminal.send("draft")
  await waitFor(() => live().includes("draft"), "draft")
  // With text in the input the hint says how to break a line, not how to see the keys.
  expect(live()).toContain("Enter send · Shift+Enter newline")
  terminal.send("\x03")
  await waitFor(() => !live().includes("draft"), "cleared")
  terminal.send("\x04")
  expect(await exited).toBe(0)
})

test("an initial prompt is sent first; input typed during startup is queued, not lost", async () => {
  const { agent, shows, idle, terminal, exited } = await setup(
    [{ text: "one", delayMs: 10 }, { text: "two" }],
    {
      initialPrompt: "INITIAL",
      leftoverInput: "typed early\r",
    },
  )
  await shows("two")
  await idle()
  const users = agent.messages
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text)
  expect(users).toEqual(["INITIAL", "typed early"])
  terminal.send("\x03")
  await exited
})

test("turn events from other sessions on the bus do not affect the UI", async () => {
  const { bus, terminal, agent, shows, idle, exited } = await setup([{ text: "hello", delayMs: 20 }])
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  bus.emit("turn.end", { reason: "done", steps: 1 }, { sessionId: "sub_agent" })
  terminal.send(`second${ALT_ENTER}`)
  await shows("queued › second")
  await idle()
  terminal.send("\x03")
  await exited
})

test("Ctrl+Q queues a message while working, like Alt+Enter", async () => {
  const { terminal, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "second answer" },
  ])
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  terminal.send("later\x11")
  await shows("queued › later")
  await shows("second answer")
  await idle()
  const users = agent.messages
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text)
  expect(users).toEqual(["go", "later"])
  terminal.send("\x03")
  await exited
})

test("a long streaming reply is committed progressively so its start stays visible", async () => {
  const reply = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n")
  const { terminal, screen, shows, idle, all, exited } = await setup([{ text: reply, delayMs: 5 }], {
    rows: 8,
  })
  terminal.send("go\r")
  await waitFor(() => screen.scrollback.join("\n").includes("line 1"), "early commit")
  await shows("line 15")
  await idle()
  const text = all()
  for (let i = 1; i <= 15; i++) expect(text.split(`line ${i}\n`).length - 1).toBeLessThanOrEqual(1)
  expect(text.indexOf("line 1\n")).toBeLessThan(text.indexOf("line 15"))
  terminal.send("\x03")
  await exited
})

test("a streamed reply with text-default emoji is drawn with VS16, its table aligned", async () => {
  const reply = "Got ✉ from ⚠ ops.\n\n| a | b |\n| --- | --- |\n| ✉ ☑ | x |\n| yyyy | z |"
  const { terminal, screen, shows, idle, all, exited } = await setup([{ text: reply, delayMs: 2 }])
  terminal.send("go\r")
  await shows("yyyy")
  await idle()
  expect(all()).toContain("Got ✉\uFE0F from ⚠\uFE0F ops.")
  const rows = [...screen.scrollback, ...screen.lines].filter((l) => l.includes("x") || l.includes("yyyy"))
  // Measured as the terminal draws it: ✉ with VS16 takes two cells, a bare one would take one.
  const bar = (l: string) => Bun.stringWidth(l.slice(0, l.indexOf("│")))
  const table = rows.filter((l) => l.includes("│"))
  expect(table.length).toBe(2)
  expect(bar(table[0]!)).toBe(bar(table[1]!))
  terminal.send("\x03")
  await exited
})

test("a reply longer than the screen reaches the scrollback once, in order, never cut and reprinted", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1} some text`)
  const para = Array.from({ length: 90 }, (_, i) => `P${i + 1}`)
  const tail = Array.from({ length: 10 }, (_, i) => `L${i + 31}`)
  const reply = [...lines, para.join(" "), ...tail].join("\n")
  const check = transcriptChecker([...lines.map((l) => l.split(" ")[0]!), ...para, ...tail])
  const { terminal, screen, shows, idle, exited } = await setup([{ text: reply, delayMs: 1 }], {
    cols: 40,
    rows: 12,
    onWrite: (s) => check.onWrite(s),
  })
  terminal.send("go\r")
  await shows("L40")
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  terminal.send("\x03")
  await exited
})

test("a Markdown reply streams block by block: every row once, in order, never cut and reprinted", async () => {
  const markers: string[] = []
  const m = (kind: "L" | "P") => {
    const id = `${kind}${markers.length + 1}`
    markers.push(id)
    return id
  }
  const parts = [
    `# ${m("L")} heading`,
    "",
    `Some **bold ${m("L")}** and \`code ${m("L")}\` here.`,
    Array.from({ length: 40 }, () => m("P")).join(" "),
    "",
    ...Array.from({ length: 6 }, () => `- item ${m("L")} with *emphasis*`),
    `  - nested ${m("L")}`,
    "",
    "```ts",
    ...Array.from({ length: 8 }, () => `const ${m("L")} = "x" // note`),
    "```",
    "",
    `> quoted ${m("L")}`,
    "",
    "| col | other |",
    "|-----|-------|",
    ...Array.from({ length: 5 }, () => `| ${m("L")} | **v** |`),
    "",
    `Done ${m("L")}.`,
  ]
  const check = transcriptChecker(markers)
  const { terminal, screen, shows, idle, all, exited } = await setup(
    [{ text: parts.join("\n"), delayMs: 1 }],
    {
      cols: 40,
      rows: 12,
      onWrite: (s) => check.onWrite(s),
    },
  )
  terminal.send("go\r")
  await shows(`Done ${markers.at(-1)}.`)
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  const text = all()
  expect(text).toContain(`${markers[0]} heading`)
  expect(text).not.toContain("# L1")
  expect(text).toContain("Some bold L2 and code L3 here.")
  expect(text).toContain("• item")
  expect(text).toContain("╭─ ts")
  expect(text).toContain("▎ quoted")
  expect(text).toMatch(/col +│ other/)
  // In the assistant's gutter, one blank line from the prompt's band, blank rows between blocks blank.
  expect(text).toContain(`› go\n\n\n  ${markers[0]} heading\n\n  Some bold`)
  expect(text).toContain("\n  ╭─ ts\n  │ const")
  expect(text).not.toMatch(/\n +\n/)
  terminal.send("\x03")
  await exited
})

test("a URL longer than the screen is cut to fit it, never cut and reprinted", async () => {
  // Four characters a marker, so that none is split where the URL wraps: 42 columns less the
  // reply's gutter leave 40 for the text.
  const markers = Array.from({ length: 80 }, (_, i) => `L${i + 10}`)
  const check = transcriptChecker(markers)
  const { terminal, screen, shows, idle, exited } = await setup(
    [{ text: `See https://example.com/${markers.join("/")} for details`, delayMs: 1 }],
    { cols: 42, rows: 12, onWrite: (s) => check.onWrite(s) },
  )
  terminal.send("go\r")
  await shows("for details")
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  terminal.send("\x03")
  await exited
})

test("a draft typed while a long reply streams does not cut the reply either", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`)
  const check = transcriptChecker(lines)
  const { terminal, screen, shows, idle, exited } = await setup([{ text: lines.join("\n"), delayMs: 2 }], {
    cols: 40,
    rows: 12,
    onWrite: (s) => check.onWrite(s),
  })
  terminal.send("go\r")
  await shows("L8")
  terminal.send(`\x1b[200~${Array.from({ length: 30 }, (_, i) => `draft ${i}`).join("\n")}\x1b[201~`)
  await shows("L40")
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  // The first Ctrl+C clears the draft.
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("the editor sits in a rounded box with the status in its border, and the caret inside", async () => {
  const { terminal, screen, live, exited } = await setup([], { cols: 30, rows: 12 })
  await waitFor(() => live().includes("Message Amira"), "input box")
  terminal.send("héllo 你好")
  await waitFor(() => live().includes("héllo 你好"), "typed text")
  const rows = screen.lines
  const top = rows.findIndex((l) => l.startsWith("╭"))
  expect(rows.slice(top, top + 3)).toEqual([
    `╭${"─".repeat(28)}╮`,
    "│ › héllo 你好               │",
    "╰─ m1 ──────────────── proj ─╯",
  ])
  expect(rows[top + 3]).toBe("Enter send")
  // Border, space, prompt, "héllo " and two wide characters.
  expect({ x: screen.x, y: screen.y }).toEqual({ x: 2 + 2 + 6 + 4, y: top + 1 })
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a long draft scrolls inside the input box instead of growing past the screen", async () => {
  const { terminal, screen, live, exited } = await setup([], { cols: 30, rows: 12 })
  await waitFor(() => live().includes("Message Amira"), "input box")
  // Typed with Shift+Enter between rows: a paste this long would be folded into a placeholder.
  terminal.send(Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\x1b[13;2u"))
  await waitFor(() => live().includes("row 20"), "draft")
  const rows = screen.lines
  const top = rows.findIndex((l) => l.startsWith("╭"))
  // A third of 12 rows shows; the border counts the rest.
  expect(rows[top]).toContain("↑ 16 rows")
  expect(rows.slice(top + 1, top + 5).map((l) => l.slice(1, -1).trim())).toEqual([
    "row 17",
    "row 18",
    "row 19",
    "row 20",
  ])
  expect(rows[top + 5]).toBe("╰─ m1 ──────────────── proj ─╯")
  // The start of the transcript is still in view: the box did not push it off.
  expect(rows[1]).toContain("Amira")
  // Moving up past the shown rows scrolls, and the border says what is below.
  for (let i = 0; i < 6; i++) terminal.send("\x1b[A")
  // The count of rows below goes into the border after the status.
  await waitFor(() => live().includes("╰─ m1 ───── proj · ↓ 3 rows ─╯"), "scrolled up")
  expect(live()).toContain("↑ 13 rows")
  expect(screen.y).toBe(top + 1)
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a reply with only thinking shows that it thought, not that there was no reply", async () => {
  const { terminal, shows, idle, all, exited } = await setup([{ thinking: "hmm" }])
  terminal.send("go\r")
  await shows("∴ Thought for 1s")
  await idle()
  expect(all()).not.toContain("No reply")
  // Folded: the thinking itself is not shown at the summary level.
  expect(all()).not.toContain("hmm")
  terminal.send("\x03")
  await exited
})

test("a reply's thinking goes before its text", async () => {
  const { terminal, shows, idle, all, exited } = await setup([{ thinking: "first idea", text: "Answer." }])
  terminal.send("go\r")
  await shows("Answer.")
  await idle()
  expect(all()).toMatch(/∴ Thought for 1s\n\n {2}Answer\./)
  terminal.send("\x03")
  await exited
})

test("startup extension errors are shown in the transcript", async () => {
  const startupEvents: AnyEvent[] = [
    { seq: 1, ts: 0, sessionId: "host", type: "extension.error", data: { source: "x.ts", error: "boom" } },
    {
      seq: 2,
      ts: 0,
      sessionId: "host",
      type: "extension.error",
      data: { source: "settings", error: 'f: unknown setting "colour" (ignored)' },
    },
  ]
  const { shows, terminal, exited } = await setup([], { startupEvents })
  await shows("Extension x.ts: boom")
  await shows('Settings: f: unknown setting "colour" (ignored)')
  terminal.send("\x03")
  await exited
})

test("the running tool is on screen before the tool starts, even if it blocks the event loop", async () => {
  const { terminal, screen, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "block", args: {} }] },
    { text: "ok" },
  ])
  let seenWhileRunning = ""
  agent.tools.register(
    defineTool({
      name: "block",
      description: "",
      parameters: {},
      execute: async () => {
        seenWhileRunning = screen.lines.join("\n")
        const until = performance.now() + 200
        while (performance.now() < until) {}
        return textResult("done")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("● block")
  await idle()
  // The running tool is drawn as its own line with a spinner and its time on the right, and the
  // activity line under it keeps its spinner, says what runs and the turn's time.
  expect(seenWhileRunning).toMatch(/● block +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0s/)
  expect(seenWhileRunning).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 tool running · 0s( · ↓ \d+ tokens)?$/m)
  terminal.send("\x03")
  await exited
})

test("running tools show as lines with their arguments and are replaced by the result", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "slow", args: { command: "bun test --watch" } }] },
    { text: "ok" },
  ])
  let release!: () => void
  agent.tools.register(
    defineTool({
      name: "slow",
      description: "",
      parameters: {},
      execute: () =>
        new Promise((r) => {
          release = () => r(textResult("passed"))
        }),
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("● slow bun test --watch"), "running line")
  release()
  await shows("└ passed")
  await idle()
  // The live line was replaced by the committed one, not left behind as a duplicate.
  expect(all().split("● slow bun test --watch").length - 1).toBe(1)
  terminal.send("\x03")
  await exited
})

test("Enter while working steers the turn; the message joins it before the next model call", async () => {
  const { terminal, live, all, shows, idle, exited } = await setup([
    { text: "looking", delayMs: 40, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    (req) => ({ text: `saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await waitFor(() => live().includes(`Enter steer · ${QUEUE_HINT} queue`), "steer hint")
  terminal.send("also B\r")
  await shows("saw also B")
  await idle()
  const text = all()
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("› also B"))
  expect(text.indexOf("› also B")).toBeLessThan(text.indexOf("saw also B"))
  expect(live()).not.toContain("steering ›")
  terminal.send("\x03")
  await exited
})

test('with tui.submitWhileWorking "queue", Enter queues while working and the queue key steers', async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup(
    [
      { text: "looking", delayMs: 60, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
      (req) => ({ text: `saw ${lastUserText(req)}` }),
      (req) => ({ text: `then ${lastUserText(req)}` }),
    ],
    { settings: { submitWhileWorking: "queue" }, cols: 80 },
  )
  // Idle, Enter just sends.
  await waitFor(() => live().includes("Enter send"), "idle hint")
  terminal.send("go\r")
  await waitFor(() => live().includes(`Enter queue · ${QUEUE_HINT} steer`), "the swapped hint")
  terminal.send("after it\r")
  await shows("queued › after it")
  terminal.send("now B\x11")
  await shows("saw now B")
  await shows("then after it")
  await idle()
  const users = agent.messages
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text)
  // The steer joined the first turn; the queued one became the next.
  expect(users).toEqual(["go", "now B", "after it"])
  terminal.send("\x03")
  await exited
})

test("submit.steer and submit.queue keys do one thing whatever the setting; commands still run at once", async () => {
  for (const mode of ["steer", "queue"] as const) {
    const keys = new Keybindings({
      ...defaultKeys({ vscode: false }),
      "submit.steer": ["ctrl+t"],
      "submit.queue": ["ctrl+g"],
    })
    const { terminal, agent, shows, idle, exited } = await setup(
      [
        { text: "looking", delayMs: 300, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
        (req) => ({ text: `saw ${lastUserText(req)}` }),
        (req) => ({ text: `then ${lastUserText(req)}` }),
      ],
      { keybindings: keys, settings: { submitWhileWorking: mode }, commands: testCommands([]), cols: 80 },
    )
    terminal.send("go\r")
    await waitFor(() => agent.status === "working", "working")
    terminal.send("later\x07")
    await shows("queued › later")
    terminal.send("B\x14")
    // A slash command sent with either key runs now, not after the turn.
    terminal.send("/status\x07")
    await shows("STATUS OK")
    expect(agent.status).toBe("working")
    await shows("saw B")
    await shows("then later")
    await idle()
    const users = agent.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content[0] as { text: string }).text)
    expect(users).toEqual(["go", "B", "later"])
    terminal.send("\x03")
    await exited
  }
})

test("steering the final reply becomes the next turn, not editor text", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "next reply" },
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send("then this\r")
  await shows("next reply")
  await idle()
  expect(agent.messages.filter((m) => m.role === "user").length).toBe(2)
  expect(live()).not.toContain("steering ›")
  // The editor is empty (its placeholder shows) and the message appears once, as a prompt.
  expect(live()).toContain("› Message Amira")
  expect(live().split("› then this").length).toBe(2)
  terminal.send("\x03")
  await exited
})

test("Esc with a steering message waiting stops the turn and sends the message at once", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send("keep this\r")
  await waitFor(() => live().includes("steering › keep this"), "steering line")
  expect(live()).toContain("Esc send queued")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  await shows("saw keep this")
  await idle()
  expect(live()).not.toContain("steering ›")
  expect(agent.messages.filter((m) => m.role === "user").length).toBe(2)
  terminal.send("\x03")
  await exited
})

test("Esc merges the steering and queued messages into one, in the order they were typed", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `saw ${lastUserText(req).replace(/\n\n/g, " + ")}` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send(`then summarize${ALT_ENTER}`)
  await waitFor(() => live().includes("queued › then summarize"), "queued line")
  terminal.send("also check b\r")
  await waitFor(() => live().includes("steering › also check b"), "steering line")
  terminal.send("\x1b[27u")
  await shows("saw then summarize + also check b")
  await idle()
  // One prompt, shown as the messages it was made of.
  expect(agent.messages.filter((m) => m.role === "user").length).toBe(2)
  expect(all()).toContain("› then summarize")
  expect(all()).toContain("› also check b")
  terminal.send("\x03")
  await exited
})

test("a message sent right after Esc goes after the messages Esc released, not before them", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `saw ${lastUserText(req)}` }),
    (req) => ({ text: `saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send(`then summarize${ALT_ENTER}`)
  await waitFor(() => live().includes("queued › then summarize"), "queued line")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  // Typed while the released message still waited out a second Esc: it does not overtake it.
  terminal.send("and then this\r")
  await shows("saw and then this")
  await idle()
  expect(userTexts(agent)).toEqual(["go", "then summarize", "and then this"])
  terminal.send("\x03")
  await exited
})

test("waiting messages take at most two rows each, and a few of them, above the input", () => {
  const long = "word ".repeat(40)
  const rows = pendingMessageRows(
    [
      { label: "steering", text: long },
      { label: "queued", text: "short" },
      { label: "queued", text: "two" },
      { label: "queued", text: "three" },
      { label: "queued", text: "four" },
    ],
    40,
    plain.theme,
  )
  expect(rows).toEqual([
    "steering › word word word word word word",
    "           word word word word word wor…",
    "queued › short",
    "queued › two",
    "+2 more waiting",
  ])
})
