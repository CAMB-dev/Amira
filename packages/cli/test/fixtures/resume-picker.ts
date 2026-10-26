import { mock } from "bun:test"
import * as tui from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { SPAWN_WAIT_TIMEOUT_MS, waitForSpawnCondition } from "../../../../scripts/spawn-test.ts"

// Run the real CLI and UI in a child process, replacing only the terminal boundary.
const runUi = tui.runInteractive
const terminal = new FakeTerminal(100, 30)
Object.defineProperty(process.stdin, "isTTY", { value: true })
Object.defineProperty(process.stdout, "isTTY", { value: true })
const waitFor = (check: () => boolean, timeoutMs = SPAWN_WAIT_TIMEOUT_MS) =>
  waitForSpawnCondition("resume picker", check, timeoutMs)
mock.module("@amira/tui", () => ({
  ...tui,
  runInteractive: async (opts: tui.InteractiveOptions) => {
    process.stdout.write(`startup stored: ${!!opts.agent?.session}\n`)
    let settled = false
    const exited = runUi({
      ...opts,
      terminal,
      env: {},
      setup: async () => ({
        capabilities: {
          win32InputMode: false,
          kittyKeyboard: true,
          synchronizedOutput: false,
          shiftEnter: true,
        },
        leftoverInput: "",
      }),
    }).finally(() => {
      settled = true
    })
    const mode = process.env.TEST_PICKER_MODE
    if (mode === "slash") {
      await waitFor(() => terminal.output.includes("Amira"))
      terminal.send("/resume\r")
    }
    await waitFor(
      () => terminal.output.includes("Resume which session?"),
      mode === "slash" ? 5000 : SPAWN_WAIT_TIMEOUT_MS,
    )
    terminal.send(process.env.TEST_PICKER_KEY!)
    if (mode === "slash") {
      // The picker leaves its own cancelled echo.
      await waitFor(() => terminal.output.includes("cancelled"), 5000)
      if (settled || opts.commands!.agent !== opts.agent)
        throw new Error("cancelling /resume changed the active session")
      terminal.send("/quit\r")
    } else if (mode === "select") {
      await waitFor(() => opts.commands!.agent !== opts.agent, 5000)
      if (!opts.commands!.agent.session) throw new Error("selection did not open a stored session")
      terminal.send("/quit\r")
    }
    await waitFor(() => settled, 5000)
    const code = await exited
    process.stdout.write(`picker exited: ${code}\n`)
    return code
  },
}))
await import("../../src/main.ts")
