import { expect, test } from "bun:test"
import { FakeTerminal } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { headerLine } from "../src/header.ts"
import { TerminalStatus } from "../src/terminal-status.ts"

for (const [title, shown] of [
  ["Fix parse_args in my_module", "Fix parse_args in my_module"],
  ["Fix `parse_args` in **my_module**", "Fix parse_args in my_module"],
  ["**bold** and *em*", "bold and em"],
  ["__bold__ and _em_", "bold and em"],
  ["_my_module_ and snake_case", "my_module and snake_case"],
  ["a * b and a _ b", "a * b and a _ b"],
  ["a* and _unfinished", "a* and _unfinished"],
  ["intraword_em_ and 字_词_", "intraword_em_ and 字_词_"],
  ["`lone backtick", "lone backtick"],
] as const) {
  test(`display titles strip only Markdown markers: ${title}`, async () => {
    expect(headerLine({ cwd: "~/project", title }, 120, plain)).toContain(` ·  ${shown}`)
    const terminal = new FakeTerminal()
    const screen = new VirtualScreen(120, 24)
    const write = terminal.write.bind(terminal)
    terminal.write = (data) => {
      write(data)
      screen.write(data)
    }
    const status = new TerminalStatus(terminal, { progress: false }, {})
    status.start()
    try {
      status.setTitle(title)
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      expect(screen.oscs).toEqual([`0;${shown}`])
    } finally {
      status.stop()
    }
  })
}
