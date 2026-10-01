import { afterEach, expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AskQuestion, defineTool, textResult } from "@amira/api"
import {
  Agent,
  type Approver,
  type Asker,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "@amira/core"
import { FakeTerminal, setColorEnabled } from "@amira/tui-kit"
import builtinTools from "../../../extensions/builtin-tools/src/index.ts"
import statusExtension from "../../../extensions/status/src/index.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { fileList } from "../src/file-index.ts"

/**
 * The unified dialog on the fake terminal, in both modes: ask_user asked by the model, an
 * approval, the free-text choice, narrow screens, CJK and NO_COLOR.
 */

type Mode = "inline" | "fullscreen"
const MODES: Mode[] = ["inline", "fullscreen"]

const ESC = "\x1b[27u"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const LEFT = "\x1b[D"

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const QUESTIONS: AskQuestion[] = [
  {
    question: "Which approach do you prefer?",
    header: "Approach",
    options: [
      { label: "Rewrite (Recommended)", description: "Start over" },
      { label: "Patch", description: "Fix it in place" },
    ],
  },
  {
    question: "What else should I do?",
    header: "Extras",
    options: [{ label: "Tests" }, { label: "Docs" }, { label: "Changelog" }],
    multiSelect: true,
  },
]

const askUser = (questions: AskQuestion[] = QUESTIONS): MockStep => ({
  toolCalls: [{ name: "ask_user", args: { questions } }],
})

interface Options {
  mode: Mode
  cols?: number
  rows?: number
  /** Tools whose calls need approval. */
  approve?: string[]
}

async function setup(steps: MockStep[], o: Options) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const interceptors = new InterceptorRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools })
  await host.load(statusExtension, "builtin:status")
  await host.load(builtinTools, "builtin:tools")
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  // Like the CLI's userAsker and userApprover (which key "always" by tool and reason, not tool alone).
  const ask: Asker = async (req, signal) => {
    const answers = await host.ui.api().ask(req.questions, { signal })
    return answers ? { answers } : { declined: true }
  }
  const allowed = new Set<string>()
  const approve: Approver = async (req, signal) => {
    if (allowed.has(req.name)) return { approved: true, by: "rule" }
    const answer = await host.ui.ask(
      { kind: "confirm", title: `Allow ${req.name}?`, message: req.reason, always: true, other: true },
      { signal, source: "approval" },
    )
    if (answer === "always") allowed.add(req.name)
    if (answer === true || answer === "always") return { approved: true, by: "user" }
    if (typeof answer === "object") return { approved: false, reason: `the user said no: ${answer.other}` }
    if (answer === undefined && !signal.aborted)
      return { approved: false, reason: "dismissed", interrupt: true }
    return { approved: false, reason: "the user said no" }
  }
  const agent = new Agent({
    ai,
    model: ai.model("mock/m1"),
    cwd: "/work/proj",
    systemPrompt: "",
    bus,
    tools,
    interceptors,
    ask,
    approve,
  })
  tools.register(
    defineTool({ name: "wipe", description: "", parameters: {}, execute: async () => textResult("wiped") }),
    "test",
  )
  for (const name of o.approve ?? []) {
    interceptors.add("tool.call.before", (v) =>
      v.name === name ? { action: "ask", reason: "it deletes files" } : { action: "pass" },
    )
  }
  const cols = o.cols ?? 60
  const rows = o.rows ?? 24
  const terminal = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  const exited = runInteractive({
    agent,
    status: host.status,
    ui: host.ui,
    toolRenderers: host.renderers,
    terminal,
    mode: o.mode,
    setup: async () => ({
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      leftoverInput: "",
    }),
    onReady: () => agent.start("startup"),
    files: fileList([]),
    env: {},
  })
  const live = () => screen.lines.join("\n")
  const all = () => [...screen.scrollback, ...screen.lines].join("\n")
  /** The dialog as it shows now: the rows with its bar, down to its keys. */
  const dialog = () => {
    const lines = screen.lines.map((l) => l.trimEnd())
    // The open dialog is the last run of barred rows, ending with its keys (echoes have none).
    const end = lines.findLastIndex((l) => l.startsWith("┃") && / cancel$| back$| deny$/.test(l))
    if (end === -1) return []
    let start = end
    while (start > 0 && lines[start - 1]!.startsWith("┃")) start--
    return lines.slice(start, end + 1)
  }
  const shows = (s: string) => waitFor(() => all().includes(s), JSON.stringify(s))
  const idle = async () => {
    await waitFor(() => agent.status === "idle", "idle")
    await bus.flush()
    await Bun.sleep(40)
  }
  const toolResult = (name: string) => {
    const m = agent.messages.find((m) => m.role === "toolResult" && m.toolName === name)
    return m?.role === "toolResult" && m.content[0]?.type === "text" ? m.content[0].text : undefined
  }
  await waitFor(() => all().includes("Amira"), "the banner")
  return { agent, host, terminal, screen, live, all, dialog, shows, idle, toolResult, exited }
}

afterEach(() => setColorEnabled(true))

for (const mode of MODES) {
  test(`${mode}: the model's questions are asked in one barred block and answered together`, async () => {
    const s = await setup([askUser(), { text: "Patching it." }], { mode })
    s.terminal.send("fix the bug\r")
    await waitFor(() => s.dialog().length > 0, "the dialog")
    expect(s.dialog()).toEqual([
      "┃ 1/2 · Approach",
      "┃ ? Which approach do you prefer?",
      "┃",
      "┃ ❯ 1 Rewrite (Recommended)  Start over",
      "┃   2 Patch                  Fix it in place",
      "┃   3 Other…",
      "┃",
      "┃ ←→ question · ↑↓ move · Enter next · Esc cancel",
    ])
    s.terminal.send("2")
    await waitFor(() => s.dialog()[0] === "┃ 2/2 · Extras", "the second question")
    // Back to the first and forward again: the answer is kept.
    s.terminal.send(LEFT)
    await waitFor(() => s.dialog().includes("┃ ❯ 2 Patch                  Fix it in place"), "back")
    s.terminal.send("\x1b[C")
    await waitFor(() => s.dialog()[0] === "┃ 2/2 · Extras", "forward")
    s.terminal.send(" ")
    s.terminal.send("3")
    await waitFor(() => s.dialog().includes("┃ ❯ 3 [x] Changelog"), "checked")
    expect(s.dialog()).toContain("┃   1 [x] Tests")
    s.terminal.send("\r")
    await s.shows("Patching it.")
    await s.idle()
    expect(s.toolResult("ask_user")).toBe(
      [
        "The user answered:",
        "1. Which approach do you prefer?",
        "   → Patch",
        "2. What else should I do?",
        "   → Tests, Changelog",
      ].join("\n"),
    )
    // No echo of the dialog: the tool call's result shows the answers.
    expect(s.all()).not.toContain("┃ ? Which approach do you prefer? ❯")
    // Each question's label, with the answer whole under it.
    expect(s.all()).toMatch(/Approach\n +Patch\n/)
    expect(s.dialog()).toEqual([])
    s.terminal.send("\x03")
    await s.exited
  })

  test(`${mode}: Other takes free text; Esc leaves the field, a second Esc declines`, async () => {
    const s = await setup(
      [askUser([QUESTIONS[0]!]), { text: "ok" }, askUser([QUESTIONS[0]!]), { text: "fine" }],
      {
        mode,
      },
    )
    s.terminal.send("go\r")
    await waitFor(() => s.dialog().length > 0, "the dialog")
    s.terminal.send("3")
    await waitFor(() => s.dialog().some((l) => l.includes("Type your answer")), "the text field")
    // Digits and y are text in the field.
    s.terminal.send("both, 2 steps")
    await waitFor(() => s.dialog().includes("┃ ❯ 3 both, 2 steps"), "typed")
    expect(s.dialog().at(-1)).toBe("┃ Enter submit · Esc back")
    s.terminal.send("\r")
    await s.shows("ok")
    await s.idle()
    expect(s.toolResult("ask_user")).toBe(
      'The user answered:\n1. Which approach do you prefer?\n   → (own words) "both, 2 steps"',
    )
    expect(s.all()).toContain('└ (own words) "both, 2 steps"')
    s.terminal.send("again\r")
    await waitFor(() => s.dialog().length > 0, "the second dialog")
    s.terminal.send(`${UP}\r`)
    await waitFor(() => s.dialog().some((l) => l.includes("Type your answer")), "the text field")
    s.terminal.send(ESC)
    await waitFor(() => s.dialog().includes("┃ ❯ 3 Other…"), "the field closed")
    s.terminal.send(ESC)
    await s.shows("fine")
    await s.idle()
    const results = s.agent.messages.filter((m) => m.role === "toolResult")
    expect(JSON.stringify(results.at(-1))).toContain("The user declined to answer.")
    expect(s.all()).not.toContain("┃ ? Which approach do you prefer? ❯")
    s.terminal.send("\x03")
    await s.exited
  })

  test(`${mode}: narrow screens put descriptions under their labels, and CJK fits its cells`, async () => {
    const cjk: AskQuestion = {
      question: "你想用哪种方法来实现这个功能？",
      options: [
        { label: "重写（推荐）", description: "从头开始写这个模块" },
        { label: "修补", description: "就地修复" },
      ],
    }
    const s = await setup([askUser([QUESTIONS[0]!]), { text: "a" }, askUser([cjk]), { text: "b" }], {
      mode,
      cols: 32,
      rows: 30,
    })
    s.terminal.send("go\r")
    await waitFor(() => s.dialog().length > 0, "the dialog")
    expect(s.dialog()).toEqual([
      "┃ ? Which approach do you",
      "┃   prefer?",
      "┃",
      "┃ ❯ 1 Rewrite (Recommended)",
      "┃     Start over",
      "┃   2 Patch",
      "┃     Fix it in place",
      "┃   3 Other…",
      "┃",
      "┃ Enter choose · Esc cancel",
    ])
    s.terminal.send("1")
    await s.shows("a")
    await s.idle()
    s.terminal.send("again\r")
    await waitFor(() => s.dialog().length > 0, "the CJK dialog")
    expect(s.dialog()).toEqual([
      "┃ ? 你想用哪种方法来实现这个功能",
      "┃   ？",
      "┃",
      "┃ ❯ 1 重写（推荐）",
      "┃     从头开始写这个模块",
      "┃   2 修补",
      "┃     就地修复",
      "┃   3 Other…",
      "┃",
      "┃ Enter choose · Esc cancel",
    ])
    s.terminal.send("2")
    await s.shows("b")
    await s.idle()
    // The echo wraps like any line: the answer follows the question.
    expect(s.all()).toContain("└ 修补")
    expect(s.all()).toContain("└ Rewrite (Recommended)")
    s.terminal.send("\x03")
    await s.exited
  })

  test(`${mode}: an approval is a list in the warning color; "don't ask again" holds, Other says what instead`, async () => {
    const s = await setup(
      [
        { toolCalls: [{ name: "wipe", args: {} }] },
        { toolCalls: [{ name: "wipe", args: {} }] },
        { text: "wiped twice" },
      ],
      { mode, approve: ["wipe"] },
    )
    s.terminal.send("clean up\r")
    await waitFor(() => s.dialog().length > 0, "the approval")
    expect(s.dialog()).toEqual([
      "┃ ? Allow wipe? (approval)",
      "┃   it deletes files",
      "┃",
      "┃   Yes",
      "┃   Yes, and don't ask again this session",
      "┃   No",
      "┃   Other…",
      "┃",
      "┃ ↑↓ select · n no · Esc deny",
    ])
    // Nothing is preselected: an Enter typed now does not answer it.
    s.terminal.send("\r")
    await Bun.sleep(30)
    expect(s.host.ui.pending.length).toBe(1)
    s.terminal.send(`${DOWN}${DOWN}`)
    await waitFor(() => s.dialog().includes("┃ ❯ Yes, and don't ask again this session"), "moved")
    // The bar is drawn in the warning color (yellow), the ❯ in the accent (cyan).
    expect(s.terminal.output).toContain("\x1b[33m┃")
    expect(s.terminal.output).toContain("\x1b[36m❯")
    s.terminal.send("\r")
    await s.shows("wiped twice")
    await s.idle()
    expect(s.host.ui.pending).toEqual([])
    expect(s.all()).not.toContain("┃ ? Allow wipe? ❯")
    // Asked once for both calls.
    expect(s.all().split("? Allow wipe? (approval)").length).toBeLessThanOrEqual(2)
    // Each call says who let it run.
    expect(s.all()).toContain("└ wiped · allowed by you")
    expect(s.all()).toContain("└ wiped · allowed · session rule")
    s.terminal.send("\x03")
    await s.exited
  })
}

test("Esc on an approval denies the call and stops the turn; meanwhile the activity line waits for you", async () => {
  const s = await setup([{ toolCalls: [{ name: "wipe", args: {} }] }, { text: "tried another way" }], {
    mode: "inline",
    approve: ["wipe"],
  })
  s.terminal.send("clean up\r")
  await waitFor(() => s.dialog().length > 0, "the approval")
  expect(s.live()).toMatch(/waiting for you · \d+s/)
  s.terminal.send(ESC)
  await s.idle()
  expect(s.host.ui.pending).toEqual([])
  expect(s.all()).toContain("Interrupted")
  // The turn stopped: the model was not asked again.
  expect(s.all()).not.toContain("tried another way")
  s.terminal.send("\x03")
  await s.exited
})

test("an approval refused with free text tells the model what to do instead", async () => {
  const s = await setup([{ toolCalls: [{ name: "wipe", args: {} }] }, { text: "ok, moving to trash" }], {
    mode: "inline",
    approve: ["wipe"],
  })
  s.terminal.send("clean up\r")
  await waitFor(() => s.dialog().length > 0, "the approval")
  s.terminal.send(`${UP}\r`)
  s.terminal.send("move them to the trash\r")
  await s.shows("ok, moving to trash")
  await s.idle()
  expect(s.toolResult("wipe")).toContain("the user said no: move them to the trash")
  expect(s.all()).toContain("the user said no: move them to")
  s.terminal.send("\x03")
  await s.exited
})

test("with NO_COLOR the bar and ❯ still mark the dialog and its selection", async () => {
  setColorEnabled(false)
  for (const mode of MODES) {
    const s = await setup([askUser([QUESTIONS[0]!]), { text: "done" }], { mode })
    s.terminal.send("go\r")
    await waitFor(() => s.dialog().length > 0, "the dialog")
    expect(s.dialog().slice(0, 4)).toEqual([
      "┃ ? Which approach do you prefer?",
      "┃",
      "┃ ❯ 1 Rewrite (Recommended)  Start over",
      "┃   2 Patch                  Fix it in place",
    ])
    // No colors at all: foreground colors are SGR 30–39 and 90–97.
    expect(s.terminal.output).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(3\\d|9[0-7])m`))
    s.terminal.send(`${DOWN}`)
    await waitFor(() => s.dialog().includes("┃ ❯ 2 Patch                  Fix it in place"), "moved")
    s.terminal.send("\r")
    await s.shows("done")
    await s.idle()
    s.terminal.send("\x03")
    await s.exited
  }
})
