import { expect, test } from "bun:test"
import { FakeTerminal } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { TerminalStatus, type TerminalStatusOptions } from "../src/terminal-status.ts"

function setup(
  opts: TerminalStatusOptions = {},
  env: Record<string, string | undefined> = { WT_SESSION: "1" },
) {
  const terminal = new FakeTerminal()
  const screen = new VirtualScreen(80, 24)
  const write = terminal.write.bind(terminal)
  terminal.write = (d) => {
    write(d)
    screen.write(d)
  }
  const status = new TerminalStatus(terminal, opts, env)
  status.start()
  return { terminal, screen, status }
}
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

test("effects coalesce outside frame writes and restore the title stack and progress before focus", async () => {
  const { terminal, screen, status } = setup()
  status.setTitle("first")
  status.setTitle("Amira · proj")
  status.setProgress("indeterminate")
  status.setProgress("paused")
  status.bell()
  expect(screen.oscs).toEqual([])
  terminal.write("frame")
  await flush()
  expect(screen.oscs).toEqual(["0;Amira · proj", "9;4;4;100"])
  expect(screen.bells).toBe(1)
  expect(terminal.output).toContain("frame\x1b[22;0t")
  const writes = terminal.writes.length
  status.setTitle("Amira · proj")
  status.setProgress("paused")
  await flush()
  expect(terminal.writes.length).toBe(writes)
  status.stop()
  expect(terminal.output.endsWith("\x1b]9;4;0;0\x07\x1b]0;\x07\x1b[23;0t\x1b[?1004l")).toBe(true)
})

test("terminal restore hands the title and progress back even without adapter stop", async () => {
  const { terminal, screen, status } = setup()
  status.setTitle("Amira · proj")
  status.setProgress("indeterminate")
  await flush()
  terminal.restore()
  expect(screen.oscs.slice(-2)).toEqual(["9;4;0;0", "0;"])
  const writes = terminal.output.length
  status.stop()
  expect(terminal.output.length).toBe(writes)
})

test("stop drops queued effects and detached calls cannot write after restore", async () => {
  const { terminal, screen, status } = setup()
  status.setTitle("queued")
  status.setProgress("paused")
  status.bell()
  status.stop()
  terminal.restore()
  const writes = terminal.output.length
  status.setTitle("late")
  status.bell()
  await flush()
  expect(terminal.output.length).toBe(writes)
  expect(screen.oscs).toEqual([])
  expect(screen.bells).toBe(0)
})

test("settings gate effects while focus reporting remains available", async () => {
  const { terminal, screen, status } = setup({ title: false, progress: false, bell: false })
  status.setTitle("ignored")
  status.setProgress("paused")
  status.bell()
  await flush()
  status.stop()
  expect(screen.oscs).toEqual([])
  expect(screen.bells).toBe(0)
  expect(terminal.output).toBe("\x1b[?1004h\x1b[?1004l")
})

for (const env of [{ TERM_PROGRAM: "iTerm.app", WT_SESSION: "1" }, { TERM_PROGRAM: "unknown" }]) {
  test(`progress is suppressed in ${env.TERM_PROGRAM}`, async () => {
    const { screen, status } = setup({}, env)
    status.setProgress("paused")
    await flush()
    status.stop()
    expect(screen.oscs).toEqual([])
  })
}

test("adapter sanitizes titles and clamps progress to the structured states", async () => {
  const { screen, status } = setup()
  status.setTitle(`safe\x1b\x07\n${"界".repeat(100)}`)
  status.setProgress("normal" as never)
  await flush()
  expect(screen.oscs).toHaveLength(1)
  expect(screen.oscs[0]).toStartWith("0;safe")
  expect(screen.oscs[0]).toEndWith("…")
  expect(screen.bells).toBe(0)
  status.stop()
})
