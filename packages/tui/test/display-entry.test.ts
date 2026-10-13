import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { SessionStore } from "@amira/core"
import { stripAnsi } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { DisplayBlock } from "../src/blocks/display.ts"
import { displayHistory } from "../src/display-history.ts"
import { historyBlocks } from "../src/fullscreen/history-blocks.ts"
import { displayEnv } from "../src/inline-display.ts"
import { setup, waitFor } from "./app-harness.ts"

test("display blocks fold, render Markdown details, and retain plain text for copying", () => {
  const block = new DisplayBlock("info", "btw: question", { details: "**side answer**", markdown: true })
  const env = displayEnv(plain.theme, 60, "summary")
  expect(block.lines(env).join("\n")).toContain("btw: question")
  expect(block.lines(env).join("\n")).not.toContain("side answer")
  expect(block.foldable()).toBe(true)
  const full = { ...env, detail: "full" as const }
  expect(block.lines(full).map(stripAnsi).join("\n")).toContain("side answer")
  expect(block.lines(full).map(stripAnsi).join("\n")).not.toContain("**")
  block.toggleFold(full)
  expect(block.lines(full).join("\n")).not.toContain("side answer")
  block.toggleFold(full)
  expect(block.lines(full).join("\n")).toContain("side answer")
  expect(block.copyText()).toBe("btw: question\n**side answer**")
})

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: command display details toggle with Ctrl+O and never become messages`, async () => {
    const s = await setup([], {
      settings: { mode },
      rows: 32,
      commands: [
        {
          name: "btw",
          description: "side output",
          echo: false,
          run: (_args, ctx) =>
            ctx.print("btw: question", "info", { details: "**side answer**", markdown: true }),
        },
      ],
    })
    try {
      s.terminal.send("/btw\r")
      await waitFor(() => s.live().includes("btw: question"), "display head")
      expect(s.live()).not.toContain("side answer")
      expect(s.agent.messages).toEqual([])
      s.terminal.send("\x0f")
      await waitFor(() => s.live().includes("side answer"), "expanded display")
      expect(s.live()).not.toContain("**")
      s.terminal.send("\x0f")
      await waitFor(() => !s.live().includes("side answer"), "folded display")
      expect(s.live()).toContain("btw: question")
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: startup resumes a display-only session with Ctrl+O details`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-display-only-tui-"))
    const store = SessionStore.create({ cwd: dir, dir })
    store.append({
      type: "display",
      text: "btw: display-only question",
      level: "info",
      details: "**display-only answer**",
      markdown: true,
    })
    const s = await setup([], {
      session: SessionStore.open(store.file),
      cwd: dir,
      settings: { mode },
      rows: 32,
    })
    try {
      await waitFor(() => s.live().includes("btw: display-only question"), "display-only startup")
      expect(s.live()).toContain("resumed")
      expect(s.live()).not.toContain("display-only answer")
      expect(s.agent.messages).toEqual([])
      s.terminal.send("\x0f")
      await waitFor(() => s.live().includes("display-only answer"), "expanded display-only startup")
      expect(s.live()).not.toContain("**")
      s.terminal.send("\x0f")
      await waitFor(() => !s.live().includes("display-only answer"), "folded display-only startup")
      expect(s.live()).toContain("btw: display-only question")
      expect(s.agent.messages).toEqual([])
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
      await s.agent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${mode}: resume renders persisted display entries, in place and foldable`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-display-tui-"))
    const store = SessionStore.create({ cwd: dir, dir })
    store.appendMessage(userMessage("main before"))
    store.append({
      type: "display",
      text: "btw: saved question",
      level: "info",
      details: "saved side answer",
      markdown: true,
    })
    store.appendMessage(userMessage("main after"))
    const s = await setup([], {
      session: SessionStore.open(store.file),
      cwd: dir,
      settings: { mode },
      rows: 40,
    })
    try {
      await waitFor(() => s.live().includes("btw: saved question"), "resumed display")
      expect(s.live()).not.toContain("saved side answer")
      const saved = displayHistory(s.agent)
      expect(saved[0]?.before).toBe(1)
      const env = displayEnv(plain.theme, 60, "summary")
      const blocks = historyBlocks(s.agent.messages, () => env, {
        displays: saved,
        hyperlinks: false,
        sessionId: () => s.agent.sessionId,
        terminal: { columns: 60 },
        noticeBlock: () => {
          throw new Error("unexpected notice")
        },
      })
      const lines = blocks.flatMap((b) => b.lines(env)).join("\n")
      expect(lines.indexOf("main before")).toBeLessThan(lines.indexOf("btw: saved question"))
      expect(lines.indexOf("btw: saved question")).toBeLessThan(lines.indexOf("main after"))
      s.terminal.send("\x0f")
      await waitFor(() => s.live().includes("saved side answer"), "expanded resumed display")
      s.terminal.send("\x0f")
      await waitFor(() => !s.live().includes("saved side answer"), "folded resumed display")
      expect(JSON.stringify(s.agent.messages)).not.toContain("saved side answer")
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
      await s.agent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
