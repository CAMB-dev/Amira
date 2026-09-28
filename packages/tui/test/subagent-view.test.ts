import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineTool, type SessionControl, textResult } from "@amira/api"
import {
  Agent,
  AgentTree,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  listSubagents,
  ToolRegistry,
} from "@amira/core"
import { agentsCommand } from "@amira/ext-agent"
import statusExtension from "@amira/ext-status"
import { FakeTerminal } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

/**
 * The interactive UI on a fake terminal with an agent tree and /agents. The `delegate` tool
 * starts one sub-agent per role in `roles`, one after the other; `wait` blocks until
 * `release()` is called.
 */
async function setup(steps: MockStep[], o: { cols?: number; rows?: number } = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  await host.load((api) => void api.registerCommand(agentsCommand()), "builtin:agent")
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m1"),
    cwd: "/work",
    systemPrompt: "",
    bus,
    tools,
    tree,
  })
  let release!: () => void
  let waiting = false
  const gate = new Promise<void>((r) => {
    release = r
  })
  tools.register(
    defineTool<{ path: string }>({
      name: "read",
      description: "",
      parameters: {},
      execute: async (p) => textResult(`contents of ${p.path}\nline 2\nline 3`),
    }),
    "test",
  )
  tools.register(
    defineTool({
      name: "wait",
      description: "",
      parameters: {},
      execute: async () => {
        waiting = true
        await gate
        return textResult("waited")
      },
    }),
    "test",
  )
  tools.register(
    defineTool<{ roles: string[] }>({
      name: "delegate",
      description: "",
      parameters: {},
      execute: async (p, ctx) => {
        const answers: string[] = []
        for (const role of p.roles) {
          const r = await ctx.session!.spawn!({ role, prompt: `task for the ${role}` }).result()
          answers.push(r.text)
        }
        return textResult(answers.join("\n"))
      },
    }),
    "test",
  )
  const control = {
    subagents: () => listSubagents(agent, tree).map((e) => e.info),
    subagentMessages: (id: string) =>
      listSubagents(agent, tree)
        .find((e) => e.info.id === id)
        ?.messages(),
  } as Partial<SessionControl> as SessionControl
  const commands = new CommandHost({ registry: host.commands, bus, ui: host.ui, control, agent })
  const cols = o.cols ?? 60
  const rows = o.rows ?? 20
  const terminal = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  const resize = (c: number, r: number) => {
    screen.resize(c, r)
    terminal.setSize(c, r)
  }
  const exited = runInteractive({
    agent,
    status: host.status,
    ui: host.ui,
    commands,
    terminal,
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
  })
  const view = () => screen.lines.join("\n")
  const idle = async () => {
    await waitFor(() => agent.status === "idle", "idle")
    await bus.flush()
    await Bun.sleep(40)
  }
  await waitFor(() => screen.text.includes("Amira"), "startup")
  return {
    agent,
    bus,
    host,
    control,
    terminal,
    screen,
    resize,
    view,
    idle,
    exited,
    release,
    isWaiting: () => waiting,
  }
}

const ESC = "\x1b[27u"

test("/agents view shows a running sub-agent live; main-session lines land in the scrollback after Esc", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }], usage: { input: 1500, output: 20 } },
    { text: "Now waiting.", toolCalls: [{ name: "wait", args: {} }] },
    { text: "child final answer" },
    { text: "all done" },
  ])
  s.terminal.send("go\r")
  await waitFor(s.isWaiting, "the child to block")
  const before = s.screen.mainText
  s.terminal.send("/agents view\r")
  await waitFor(() => s.screen.inAltScreen, "the viewer")
  await waitFor(() => s.view().includes("● wait"), "the transcript")
  const lines = s.screen.lines
  expect(lines[0]).toMatch(/^◆ explorer s_\w+ running · \d+s · 1\.5k tok +1\/1$/)
  expect(lines[1]).toBe("task: task for the explorer")
  expect(lines.slice(3, 11)).toEqual([
    "› task for the explorer",
    "",
    "● read a.ts",
    "  ⎿ contents of a.ts (+2 lines)",
    "",
    "Now waiting.",
    "",
    "● wait",
  ])
  expect(s.view()).toContain("⎿ running…")
  expect(s.view()).toContain("… working…")
  expect(lines.at(-1)).toContain("following")
  const atOpen = s.screen.mainText
  expect(atOpen).toContain(before.split("\n")[0]!)
  // The child goes on: its reply shows up at the bottom, and the main session finishes.
  s.release()
  await waitFor(() => s.view().includes("── done ──"), "the child to finish in the viewer")
  expect(s.view()).toContain("child final answer")
  await s.idle()
  expect(s.screen.inAltScreen).toBe(true)
  // Nothing was drawn on the main screen meanwhile.
  expect(s.screen.mainText).toBe(atOpen)
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "the inline UI")
  const main = s.screen.mainText
  const order = ["› go", "› /agents view", "● delegate", "⎿ child final answer", "all done"].map((t) =>
    main.indexOf(t),
  )
  expect(order.every((i) => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(main.split("all done").length).toBe(2)
  expect(main).not.toContain("◆ explorer s_")
  // The live region is back: the editor box and the hint line.
  expect(s.view()).toContain("Enter send")
  expect(s.view()).toContain("│ › Message Amira")
  expect(s.screen.altSwitches).toEqual([true, false])
  s.terminal.send("\x03")
  await s.exited
})

test("the viewer scrolls, follows the tail again at the end, and redraws on resize", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `answer line ${i + 1}`).join("\n")
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { text: long },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents view 1\r")
  await waitFor(() => s.view().includes("── done ──"), "the viewer")
  expect(s.screen.lines.at(-2)).toBe("── done ──")
  expect(s.screen.lines.at(-1)).toContain("following")
  s.terminal.send("\x1b[5~") // PgUp
  await waitFor(() => !s.screen.lines.at(-1)!.includes("following"), "scrolled up")
  expect(s.screen.lines.at(-1)).toMatch(/^\d+–\d+ of 44 · /)
  expect(s.view()).not.toContain("── done ──")
  s.terminal.send("\x1b[H") // Home
  await waitFor(() => s.screen.lines[3] === "› task for the explorer", "the top")
  expect(s.screen.lines.at(-1)).toMatch(/^1–16 of 44 · /)
  s.terminal.send("\x1b[B") // ↓
  await waitFor(() => s.screen.lines[3] === "", "one row down")
  s.terminal.send("\x1b[F") // End
  await waitFor(() => s.screen.lines.at(-1)!.includes("following"), "the end")
  s.resize(70, 12)
  await waitFor(() => s.screen.lines.at(-1)!.includes("following") && s.screen.lines.length === 12, "resized")
  await Bun.sleep(60)
  expect(s.screen.lines[0]).toMatch(/^◆ explorer/)
  expect(s.screen.lines.at(-2)).toBe("── done ──")
  expect(s.screen.lines.at(-3)).toBe("")
  expect(s.screen.lines.at(-4)).toBe("answer line 40")
  s.terminal.send("q")
  await waitFor(() => !s.screen.inAltScreen, "closed")
  s.terminal.send("\x03")
  await s.exited
})

test("←/→ and Tab switch between sub-agents; Ctrl+C closes the viewer instead of quitting", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer", "coder"] } }] },
    { text: "explored" },
    { text: "coded" },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents view\r")
  await waitFor(() => /^◆ coder .* 2\/2$/.test(s.screen.lines[0]!), "the latest sub-agent")
  expect(s.view()).toContain("coded")
  s.terminal.send("\x1b[D") // ←
  await waitFor(() => /^◆ explorer .* 1\/2$/.test(s.screen.lines[0]!), "the previous one")
  expect(s.view()).toContain("explored")
  s.terminal.send("\x1b[C") // →
  await waitFor(() => s.screen.lines[0]!.startsWith("◆ coder"), "the next one")
  s.terminal.send("\t")
  await waitFor(() => s.screen.lines[0]!.startsWith("◆ explorer"), "Tab wraps around")
  s.terminal.send("\x03")
  await waitFor(() => !s.screen.inAltScreen, "closed by Ctrl+C")
  expect(s.view()).toContain("Enter send")
  s.terminal.send("\x03")
  expect(await s.exited).toBe(0)
})

test("a main-session dialog shows as a banner in the viewer, rings once, and is answered after Esc", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { text: "explored" },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents view\r")
  await waitFor(() => s.view().includes("── done ──"), "the viewer")
  s.terminal.clearWrites()
  const answer = s.host.ui.api("approval").confirm("Allow bash?", "rm -rf build")
  await waitFor(() => s.view().includes("! Waiting for you: Allow bash? · Esc to answer"), "the banner")
  expect(s.terminal.output.split("\x07").length).toBe(2)
  expect(s.screen.inAltScreen).toBe(true)
  // Keys still go to the viewer: "y" does not answer the dialog.
  s.terminal.send("y")
  await Bun.sleep(60)
  expect(s.host.ui.pending).toHaveLength(1)
  s.terminal.send(ESC)
  await waitFor(() => s.view().includes("? Allow bash? (approval)"), "the inline dialog")
  s.terminal.send("y")
  expect(await answer).toBe(true)
  await waitFor(() => s.screen.mainText.includes("? Allow bash? › yes"), "the answer")
  s.terminal.send("\x03")
  await s.exited
})

test("/agents picks a sub-agent in an inline dialog and prints its transcript into the scrollback", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { toolCalls: [{ name: "read", args: { path: "b.ts" } }] },
    { text: "b.ts is fine" },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents\r")
  await waitFor(() => s.view().includes("? Sub-agents"), "the picker")
  expect(s.view()).toContain("  Open the live view 2")
  expect(s.view()).toMatch(/› 1\. explorer · s_\w+ · done/)
  s.terminal.send("1")
  await waitFor(() => s.screen.mainText.includes("● read b.ts"), "the transcript")
  const main = s.screen.mainText
  expect(main).toMatch(/◆ explorer · s_\w+ · done · \d+s · 0 tok/)
  expect(main).toContain("› task for the explorer")
  expect(main).toContain("  ⎿ contents of b.ts (+2 lines)")
  expect(main.lastIndexOf("b.ts is fine")).toBeGreaterThan(main.indexOf("● read b.ts"))
  expect(s.screen.inAltScreen).toBe(false)
  // The last entry opens the live view.
  s.terminal.send("/agents\r")
  await waitFor(() => s.view().includes("? Sub-agents"), "the picker again")
  s.terminal.send("2")
  await waitFor(() => s.screen.inAltScreen, "the viewer")
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  s.terminal.send("\x03")
  await s.exited
})
