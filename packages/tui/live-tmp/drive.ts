// Scratch driver (not committed): runs the real TUI on a fake terminal against DeepSeek.
import { activePackages } from "@amira/core"
import { FakeTerminal } from "@amira/tui-kit"
import { parseCliArgs } from "../../cli/src/args.ts"
import { resolveConfig } from "../../cli/src/config.ts"
import { createCommandHost } from "../../cli/src/control.ts"
import { chooseStore } from "../../cli/src/resume.ts"
import { createSession } from "../../cli/src/session.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"

const mode = (process.argv[2] ?? "fullscreen") as "fullscreen" | "inline"
const cwd = process.cwd()
const args = parseCliArgs([], cwd)
const config = resolveConfig(args)
const { store } = chooseStore({ cwd, continue: false })
const session = await createSession({
  model: config.settings.model!,
  cwd,
  extensions: [],
  packages: activePackages({ cwd }),
  store,
  disabledTools: config.disabledTools,
  requestedDisabled: config.requestedDisabled,
  settings: config.settings,
  providers: config.providers,
  apiKeys: config.apiKeys,
  warnings: config.warnings,
})
const { agent, host } = session
const commands = createCommandHost({ session, cwd, shell: config.shell, disabled: [], announce: () => {} })
const cols = 100
const rows = 40
const terminal = new FakeTerminal(cols, rows)
const screen = new VirtualScreen(cols, rows)
const write = terminal.write.bind(terminal)
terminal.write = (d: string) => {
  write(d)
  screen.write(d)
}
const all = () => [...screen.scrollback, ...screen.lines].join("\n")
const dump = (label: string) =>
  console.log(
    `\n===== ${label} =====\n${(mode === "inline" ? all() : screen.lines.join("\n")).replace(/\n+$/, "")}`,
  )
async function waitFor(check: () => boolean, what: string, ms = 180_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) {
      dump(`TIMEOUT ${what}`)
      throw new Error(`timeout: ${what}`)
    }
    await Bun.sleep(100)
  }
}
const exited = runInteractive({
  agent,
  status: host.status,
  ui: host.ui,
  commands,
  registerCommand: (c) => host.commands.register(c, "builtin:tui"),
  toolRenderers: host.renderers,
  views: host.views,
  terminal,
  mode,
  setup: async () => ({
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    leftoverInput: "",
  }),
  onReady: () => agent.start("startup"),
  files: { files: async () => [] },
  env: {},
})
await waitFor(() => all().includes("Run this project's hooks?"), "trust dialog")
dump("trust dialog")
terminal.send("y")
await waitFor(() => all().includes("hook hello"), "session start hook")
terminal.send(
  "Use the write tool to create notes.txt with the single line 'hello world'. After that, use the bash tool to run exactly: rm -rf build. Then answer in one short sentence.\r",
)
await Bun.sleep(1000)
await waitFor(() => agent.status === "idle", "turn")
await waitFor(() => all().includes("project-check"), "after turn hooks", 30_000)
await Bun.sleep(500)
dump("after the turn")
terminal.send("/hooks\r")
await waitFor(() => all().includes("Recent runs"), "/hooks")
await Bun.sleep(300)
dump("/hooks")
terminal.send("/hooks runs\r")
await Bun.sleep(1500)
dump("/hooks runs")
terminal.send("\x1b")
await Bun.sleep(500)
terminal.send("\x03")
await Promise.race([exited, Bun.sleep(3000)])
terminal.send("\x03")
await Promise.race([exited, Bun.sleep(3000)])
await host.runExitHandlers(5000)
process.exit(0)
