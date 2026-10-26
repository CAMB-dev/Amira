// The ASCII glyph set leaks no Unicode through host-composed chrome text (audit 2026-10-26).
import { expect, test } from "bun:test"
import { type SpawnGroupInfo, textResult } from "@amira/api"
import { stripAnsi } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import ascii from "../../cli/themes/ascii.json"
import { plain } from "../../tui-kit/test/context.ts"
import { activityRow } from "../src/app/activity-row.ts"
import { interruptedText, quitWarning } from "../src/app/quit.ts"
import { interactiveBanner } from "../src/app/terminal.ts"
import { Dialog } from "../src/dialog.ts"
import { spawnGroupRow } from "../src/format.ts"
import { chromeText, glyphs, setGlyphs } from "../src/glyphs.ts"
import { headerLine } from "../src/header.ts"
import { badgeSymbol } from "../src/status-badge.ts"
import { finishedToolLines, runningToolLines } from "../src/tool-view.ts"

const ascii7 = (rows: string[]) => expect(rows.map(stripAnsi).join("\n")).not.toMatch(/[^\p{ASCII}]/u)

function withAscii(run: () => void) {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    run()
  } finally {
    setGlyphs(before)
  }
}

test("chrome text follows the glyph set; Unicode mode keeps it as written", () => {
  expect(chromeText("built-in · cyan… — note")).toBe("built-in · cyan… — note")
  withAscii(() => expect(chromeText("built-in · cyan… — note")).toBe("built-in . cyan... - note"))
})

test("ASCII dialogs, notes, banner, header, badges and tool rows are ASCII", () => {
  withAscii(() => {
    const dialog = new Dialog(
      {
        kind: "select",
        requestId: "r",
        title: "Choose a theme · now",
        options: ["amira", "terminal"],
        descriptions: ["built-in · Amira's default · current", "built-in · ANSI colors…"],
      },
      () => {},
    )
    ascii7(dialog.render(60, { ...plain, glyphs: ascii.glyphs, rows: 20 }))
    const ask = new Dialog(
      { kind: "confirm", requestId: "c", title: "Allow bash?", message: "it runs", other: true },
      () => {},
    )
    // "Other" ends in three periods, not a lone one.
    expect(
      ask
        .render(60, { ...plain, rows: 20 })
        .map(stripAnsi)
        .join("\n"),
    ).toContain("Other...")
    ascii7([chromeText(quitWarning(1, 0, "ctrl+c")), interruptedText(2)])
    expect(quitWarning(1, 0, "ctrl+c")).toContain("stop it and quit")
    expect(quitWarning(1, 1, "ctrl+c")).toContain("stop them and quit")
    ascii7([interactiveBanner(plain.theme, { provider: "p", id: "m" }, "~/work/a/very/long/path/to/cwd", 20)])
    ascii7([headerLine({ cwd: "/a/very/long/working/directory/here", used: 501, limit: 200_000 }, 30, plain)])
    ascii7([badgeSymbol("working", "⠙"), badgeSymbol("queued")])
    ascii7([
      activityRow(
        {
          label: "responding",
          spinner: "⠙",
          stepMs: 61_000,
          turnMs: 62_000,
          tokens: 58,
          rate: 0,
          stop: "esc stop",
          animationMs: 0,
        },
        60,
        { ...plain, glyphs: ascii.glyphs },
      ),
    ])
    const shell = builtinPresenters.bash
    const call = {
      name: "bash",
      args: { command: "bun test", background: true },
      result: textResult("a\n\nb\nc\nd\ne\n\nExit code: 0"),
    }
    ascii7(finishedToolLines(plain.theme, shell, call, "summary", 60))
    ascii7(
      runningToolLines(plain.theme, shell, { name: "bash", args: call.args, startedAt: 0 }, 1000, "⠙", 60),
    )
    const group: SpawnGroupInfo = {
      id: "g",
      name: "workflow demo",
      parentSessionId: "main",
      state: "active",
      limits: {},
      compact: true,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tokens: 0,
      agents: { total: 1, ended: 0, working: 1, queued: 0, idle: 0 },
      status: "wf_1 · Inspect · 1 working",
    }
    ascii7([spawnGroupRow(group, 0, 80, plain.theme, true, "", "⠙")])
  })
})

test("a compact group row shows the shared badge and leaves out what its counts already say", () => {
  const group: SpawnGroupInfo = {
    id: "g",
    name: "workflow demo",
    parentSessionId: "main",
    state: "active",
    limits: {},
    compact: true,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tokens: 0,
    agents: { total: 1, ended: 0, working: 0, queued: 1, idle: 0 },
    status: "workflow demo · wf_1 · Inspect · 0/1 agent · 1 queued",
  }
  const row = stripAnsi(spawnGroupRow(group, 0, 120, plain.theme, true, ""))
  expect(row).toBe("└ · queued  workflow demo · 1 queued · 0 tok · wf_1 · Inspect · 0/1 agent")
})

test("a select row cut to the width keeps one free cell before the right border", () => {
  const dialog = new Dialog(
    { kind: "select", requestId: "r", title: "Sub-agents", options: [`Describe ${"terminal ".repeat(10)}`] },
    () => {},
  )
  const row = dialog
    .render(40, { ...plain, rows: 20 })
    .map(stripAnsi)
    .find((line) => line.includes("Describe"))!
  expect(row).toMatch(/… │$/)
})
