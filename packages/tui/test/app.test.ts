import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import statusExtension from "@amira/ext-status"
import { FakeTerminal } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { summarizeArgs } from "../src/format.ts"

const noProbe = async () => ({
  capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
  leftoverInput: "",
})

async function setup(steps: MockStep[]) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work/proj", systemPrompt: "", bus, tools })
  tools.register(
    defineTool<{ path: string }>({
      name: "read",
      description: "",
      parameters: {},
      execute: async (p) => textResult(`contents of ${p.path}\nline 2\nline 3`),
    }),
    "test",
  )
  const terminal = new FakeTerminal(60, 20)
  const screen = new VirtualScreen(60, 20)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  agent.start("startup")
  const exited = runInteractive({ agent, status: host.status, terminal, setup: noProbe })
  await Bun.sleep(20)
  const all = () => [...screen.scrollback, ...screen.lines].join("\n")
  const idle = async () => {
    while (agent.status !== "idle") await Bun.sleep(5)
    await bus.flush()
    await Bun.sleep(40)
  }
  return { agent, terminal, screen, all, idle, exited }
}

test("a conversation: user message, tool call and reply end up in the transcript", async () => {
  const { terminal, all, idle, exited } = await setup([
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    { text: "The file has three lines." },
  ])
  expect(all()).toContain("Amira")
  expect(all()).toContain("mock/m1")

  terminal.send("what is in a.ts?")
  terminal.send("\r")
  await Bun.sleep(20)
  await idle()

  const text = all()
  expect(text).toContain("› what is in a.ts?")
  expect(text).toContain("● read a.ts")
  expect(text).toContain("⎿ contents of a.ts (+2 lines)")
  expect(text).toContain("The file has three lines.")
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("The file has three lines."))

  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("Esc interrupts a running turn and messages sent meanwhile are queued", async () => {
  const { terminal, all, idle, agent, exited } = await setup([
    { text: "a very long streaming reply", delayMs: 40 },
    { text: "second answer" },
  ])
  terminal.send("first\r")
  await Bun.sleep(60)
  expect(agent.status).toBe("working")
  terminal.send("follow up\r")
  await Bun.sleep(30)
  expect(all()).toContain("queued › follow up")
  terminal.send("\x1b[27u")
  await idle()
  await Bun.sleep(50)
  await idle()
  const text = all()
  expect(text).toContain("Interrupted.")
  expect(text).toContain("› follow up")
  expect(text).toContain("second answer")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("the status bar shows items from the status extension", async () => {
  const { screen, terminal, exited } = await setup([])
  await Bun.sleep(40)
  const bottom = screen.lines.filter((l) => l.trim()).join("\n")
  expect(bottom).toContain("mock/m1")
  expect(bottom).toContain("proj")
  terminal.send("\x03")
  await exited
})

test("Ctrl+C clears a non-empty editor before quitting", async () => {
  const { terminal, screen, exited } = await setup([])
  terminal.send("draft")
  await Bun.sleep(30)
  expect(screen.lines.join("\n")).toContain("draft")
  terminal.send("\x03")
  await Bun.sleep(30)
  expect(screen.lines.join("\n")).not.toContain("draft")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("summarizeArgs keeps short scalar arguments on one line", () => {
  expect(summarizeArgs({ command: "bun  test\n--watch", timeout: 5, obj: { a: 1 } })).toBe(
    "bun test --watch 5",
  )
  expect(summarizeArgs({ x: "a".repeat(200) }, 10)).toBe(`${"a".repeat(9)}…`)
})
