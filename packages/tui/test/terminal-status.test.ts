import { expect, spyOn, test } from "bun:test"
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

test("terminal titles remove inline Markdown markers before coalescing", async () => {
  const { screen, status } = setup()
  status.setTitle("Amira · Fixing `add` **Subtraction** _Bug_")
  await flush()
  expect(screen.oscs).toEqual(["0;Amira · Fixing add Subtraction Bug"])
  status.setTitle("Amira · Fixing add Subtraction Bug")
  await flush()
  expect(screen.oscs).toHaveLength(1)
  status.stop()
})

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

test("running titles use a one-second fake clock window and final status bypasses it", async () => {
  let now = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const { screen, status } = setup()
  try {
    status.setTitle("Amira · proj")
    await flush()
    status.setRunning(true)
    status.setTitle("● Amira · first")
    await flush()
    now = 200
    status.setTitle("● Amira · second")
    await flush()
    now = 999
    status.setTitle("● Amira · latest")
    await flush()
    expect(screen.oscs.filter((o) => o.startsWith("0;"))).toEqual(["0;Amira · proj", "0;● Amira · first"])
    now = 1000
    status.setTitle("● Amira · latest")
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;● Amira · latest")
    now = 1100
    status.setTitle("● Amira · queued")
    await flush()
    status.setRunning(false)
    status.setTitle("Amira · final")
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;Amira · final")
    expect(screen.oscs).not.toContain("0;● Amira · queued")
  } finally {
    status.stop()
    clock.mockRestore()
  }
})

test("waiting alerts deduplicate until answer, retain focus context and clear on return", async () => {
  const { screen, status } = setup()
  status.setTitle("● Amira · proj")
  status.setWaiting(1, false)
  status.bell()
  await flush()
  expect(screen.bells).toBe(0) // Unknown focus: a hidden picker is not a question.
  status.setWaiting(1, true)
  status.bell()
  await flush()
  expect(screen.bells).toBe(1)
  expect(screen.oscs.at(-1)).toBe("0;? Amira · proj")
  status.setWaiting(2, true)
  status.bell()
  status.setFocused(false)
  status.bell()
  await flush()
  expect(screen.bells).toBe(1)
  status.setFocused(true)
  await flush()
  expect(screen.oscs.at(-1)).toBe("0;? Amira · proj")
  status.setWaiting(0, false)
  status.setWaiting(1, true)
  status.bell()
  await flush()
  expect(screen.bells).toBe(1) // A visible question in the foreground does not ring.
  status.setFocused(false)
  status.bell()
  await flush()
  expect(screen.bells).toBe(2)
  status.setWaiting(0, false)
  await flush()
  expect(screen.oscs.at(-1)).toBe("0;● Amira · proj")
  status.stop()
})

for (const [env, expected] of [
  [{ WT_SESSION: "1" }, undefined],
  [{ TERM_PROGRAM: "iTerm.app", WT_SESSION: "1" }, "9;Amira is waiting for your answer"],
  [{ TERM_PROGRAM: "WezTerm" }, "777;notify;Amira;Amira is waiting for your answer"],
  [{ TERM: "xterm-kitty" }, "99;;Amira is waiting for your answer"],
  [{ KITTY_WINDOW_ID: "1" }, "99;;Amira is waiting for your answer"],
  [{ TERM_PROGRAM: "ghostty" }, "9;Amira is waiting for your answer"],
  [{ TERM_PROGRAM: "unknown" }, undefined],
  [{ TERM: "dumb", TERM_PROGRAM: "ghostty" }, undefined],
  [{ TERM_PROGRAM: "WezTerm", TMUX: "1" }, undefined],
  [{ TERM_PROGRAM: "iTerm.app", STY: "1" }, undefined],
] as const) {
  test(`notification OSC is terminal-specific: ${JSON.stringify(env)}`, async () => {
    const { screen, status } = setup({ bell: false }, env)
    status.setWaiting(1, true)
    status.bell()
    await flush()
    expect(screen.oscs).toEqual(expected ? [expected] : [])
    expect(screen.bells).toBe(0)
    status.bell()
    await flush()
    expect(screen.oscs).toEqual(expected ? [expected] : [])
    status.stop()
  })
}

test("notify off leaves BEL available and returning before flush cancels an alert", async () => {
  const { screen, status } = setup({ notify: "off" }, { TERM_PROGRAM: "ghostty" })
  status.setFocused(false)
  status.setRunning(true)
  status.setRunning(false)
  status.bell()
  await flush()
  expect(screen.oscs).toEqual([])
  expect(screen.bells).toBe(1)
  status.setRunning(true)
  status.setRunning(false)
  status.bell()
  status.setFocused(true)
  await flush()
  expect(screen.bells).toBe(1)
  status.stop()
})

test("returning or answering before flush drops queued BEL and notification OSC", async () => {
  const { screen, status } = setup({}, { TERM_PROGRAM: "ghostty" })
  status.setFocused(false)
  status.setRunning(true)
  status.setRunning(false)
  status.bell()
  status.setFocused(true)
  await flush()
  status.setFocused(false)
  status.setWaiting(1, true)
  status.bell()
  status.setWaiting(0, false)
  await flush()
  expect(screen.oscs).toEqual([])
  expect(screen.bells).toBe(0)
  status.stop()
})

test("a throttled title flushes the latest value on its timer without another frame", async () => {
  let now = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const { screen, status } = setup()
  try {
    status.setRunning(true)
    status.setTitle("● Amira · first")
    await flush()
    now = 999
    status.setTitle("● Amira · latest")
    await flush()
    expect(screen.oscs).toEqual(["0;● Amira · first"])
    now = 1000
    await Bun.sleep(10)
    expect(screen.oscs).toEqual(["0;● Amira · first", "0;● Amira · latest"])
  } finally {
    status.stop()
    clock.mockRestore()
  }
})

test("foreground questions never alert; unknown focus never alerts on completion", async () => {
  const { screen, status } = setup({}, { TERM_PROGRAM: "ghostty" })
  status.setRunning(true)
  status.setRunning(false)
  await flush()
  expect(screen.bells).toBe(0)
  expect(screen.oscs).toEqual([])
  status.setFocused(true)
  status.setWaiting(1, true)
  status.bell()
  await flush()
  expect(screen.bells).toBe(0)
  expect(screen.oscs).toEqual([])
  status.stop()
})

test("waiting transitions bypass the running title throttle and focus never hides an open question", async () => {
  let now = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const { screen, status } = setup()
  try {
    status.setRunning(true)
    status.setTitle("● Amira · first")
    await flush()
    now = 200
    status.setFocused(false)
    status.setWaiting(1, true)
    status.bell()
    await flush()
    expect(screen.bells).toBe(1) // Alerts are not delayed with titles.
    expect(screen.oscs).toEqual(["0;● Amira · first", "0;? Amira · first"])
    now = 300
    status.setTitle("● Amira · latest")
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;? Amira · first")
    now = 1200
    status.setTitle("● Amira · latest")
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;? Amira · latest")
    now = 1300
    status.setFocused(true)
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;? Amira · latest")
    now = 2000
    status.setTitle("● Amira · latest")
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;? Amira · latest")
    status.setWaiting(0, false)
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;● Amira · latest")
    now = 2100
    status.setRunning(false)
    status.setTitle("Amira · finished")
    await flush()
    expect(screen.oscs.at(-1)).toBe("0;Amira · finished")
  } finally {
    status.stop()
    clock.mockRestore()
  }
})
