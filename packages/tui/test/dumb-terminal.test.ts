import { expect, test } from "bun:test"
import { setup } from "./app-harness.ts"

test("TERM=dumb emits no escapes while starting, replying, printing notices and quitting", async () => {
  const s = await setup([{ text: "**plain reply** [link](https://example.com)" }], {
    env: { TERM: "dumb", WT_SESSION: "1", FORCE_HYPERLINK: "1" },
    settings: { mode: "fullscreen", images: "on" },
  })
  try {
    s.terminal.send("go\r")
    await s.shows("plain reply")
    await s.idle()
    s.bus.emit(
      "extension.notice",
      { source: "test", level: "info", text: "notice text" },
      {
        sessionId: s.agent.sessionId,
      },
    )
    await s.shows("notice text")
  } finally {
    s.terminal.send("\x03\x03")
    await s.exited
  }
  expect(s.terminal.output).toContain("plain reply")
  expect(s.terminal.output).not.toContain("\x1b")
  expect(s.terminal.output).not.toContain("\r")
})

for (const supplied of [false, true]) {
  test(`TERM=dumb strips synchronous emergency cleanup (supplied: ${supplied})`, async () => {
    const module = new URL("../src/app/terminal.ts", import.meta.url).href
    const processTerminal = new URL("../../tui-kit/src/terminal.ts", import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    const { interactiveTerminal } = await import(${JSON.stringify(module)})
    const { ProcessTerminal } = await import(${JSON.stringify(processTerminal)})
    const terminal = interactiveTerminal(${supplied ? "new ProcessTerminal()" : "undefined"}, { TERM: "dumb" })
    terminal.start()
    terminal.write("\\x1b[31mplain\\x1b[0m\\n")
    terminal.onEmergencyExit(() => "\\x1b]0;title\\x07bye\\n")
    process.emit("uncaughtExceptionMonitor", new Error("test"), "uncaughtException")
    terminal.stop()
  `,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ output, error, code }).toEqual({ output: "plain\nbye\n", error: "", code: 0 })
  }, 30_000)
}

test("TERM=dumb drops the bell as well as escapes", async () => {
  const { interactiveTerminal } = await import("../src/app/terminal.ts")
  const written: string[] = []
  const terminal = interactiveTerminal({ write: (d: string) => written.push(d) } as never, { TERM: "dumb" })
  terminal.write("a\x07b\x1b]0;t\x07c")
  expect(written).toEqual(["abc"])
})
