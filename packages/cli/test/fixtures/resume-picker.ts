import { mock } from "bun:test"
import * as tui from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { runInteractive } from "../../../tui/src/app.ts"

// Run the real CLI and UI in a child process, replacing only the terminal boundary.
const runUi = runInteractive
const terminal = new FakeTerminal(100, 30)
Object.defineProperty(process.stdin, "isTTY", { value: true })
Object.defineProperty(process.stdout, "isTTY", { value: true })
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for resume picker")
    await Bun.sleep(5)
  }
}
mock.module("@amira/tui", () => ({
  ...tui,
  runInteractive: async (opts: tui.InteractiveOptions) => {
    process.stdout.write(`startup stored: ${!!opts.agent.session}\n`)
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
    await waitFor(() => terminal.output.includes("Resume which session?"))
    terminal.send(process.env.TEST_PICKER_KEY!)
    if (mode === "slash") {
      await waitFor(() => terminal.output.includes("Recent sessions:"))
      if (settled || opts.commands!.agent !== opts.agent)
        throw new Error("cancelling /resume changed the active session")
      terminal.send("/quit\r")
    } else if (mode === "select") {
      await waitFor(() => opts.commands!.agent !== opts.agent)
      if (!opts.commands!.agent.session) throw new Error("selection did not open a stored session")
      terminal.send("/quit\r")
    }
    await waitFor(() => settled)
    const code = await exited
    process.stdout.write(`picker exited: ${code}\n`)
    return code
  },
}))
await import("../../src/main.ts")
