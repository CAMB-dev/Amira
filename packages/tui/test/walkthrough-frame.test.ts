import { expect, test } from "bun:test"
import { textResult } from "@amira/api"
import { createTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { type BlockEnv, ReplyBlock, SubagentGroupBlock, ToolBlock, userBlock } from "../src/blocks.ts"
import { reasoningLines } from "../src/format.ts"
import { headerLine } from "../src/header.ts"
import { Transcript } from "../src/transcript.ts"

const at = new Date(2026, 9, 10, 20, 9).getTime()

for (const width of [100, 50]) {
  test(`walkthrough frame at ${width} columns`, () => {
    const theme = createTheme({ theme: "dark", colorDepth: "truecolor", color: true, platform: "linux" })
    const env: BlockEnv = {
      theme,
      width,
      now: at + 6000,
      spinner: "⠋",
      detail: "summary",
      presenters: undefined,
      hyperlinks: false,
      nodes: new Map([
        [
          "child",
          {
            id: "child",
            parent: "main",
            toolCallId: "delegate",
            title: "List project files",
            role: "explorer",
            depth: 1,
            startedAt: at,
            tokens: 31_000,
            activity: { name: "bash", summary: "ls src" },
          },
        ],
        [
          "background-child",
          {
            id: "background-child",
            parent: "main",
            title: "Review project structure",
            role: "explorer",
            depth: 1,
            startedAt: at,
            tokens: 6000,
            activity: { name: "read", summary: "package.json" },
          },
        ],
      ]),
    }
    const delegate = new ToolBlock("delegate", "agent", {}, "main")
    delegate.startedAt = at
    const edit = new ToolBlock("edit", "edit", { path: "src/add.ts" }, "main")
    edit.end = { result: textResult("+1 -1") }
    const check = new ToolBlock("check", "bash", { command: "bun test src/add.test.ts" }, "main")
    check.end = { result: textResult("12 pass"), durationMs: 1200 }
    const background = new SubagentGroupBlock("background-child")
    background.last = true
    const reply = new ReplyBlock(
      "Here is the corrected function:\n\n```ts\nexport function add(left: number, right: number): number {\n  return left + right;\n}\n```",
      false,
      false,
      at,
    )
    const transcript = new Transcript()
    const rows = [
      headerLine(
        { cwd: "~/dev/Amira", branch: "main", title: "Fixing `add` Bug", used: 31_000, limit: 200_000 },
        width,
        { theme, color: true, rows: 40 },
      ),
      "",
      ...transcript.block(
        "user",
        userBlock(
          { role: "user", content: [{ type: "text", text: "Fix add and check the project." }] },
          at,
        ).lines(env),
      ),
      ...transcript.block(
        "reasoning",
        reasoningLines(theme, "Check the operator.", { durationMs: 4200 }, width),
      ),
      ...transcript.block("assistant", reply.lines(env)),
      ...[delegate, edit, check, background].flatMap((block) => transcript.block("tool", block.lines(env))),
    ].map(stripAnsi)
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
    expect(rows.join("\n")).toMatchSnapshot()
    if (process.env.TUI_WALKTHROUGH_FRAMES === "1")
      console.log(`FRAME ${width}\n${rows.join("\n")}\nEND FRAME ${width}`)
  })
}
