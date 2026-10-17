import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeImageApp, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: @file completion follows owned cwd and restores the host main source`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "amira-focus-files-"))
    writeFileSync(join(cwd, "design-only.ts"), "export const design = true\n")
    const s = await focusFixture(mode, [{ text: "Reference received" }], cwd)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      s.terminal.send("@design")
      await s.shows("design-only.ts")
      expect(s.live()).not.toContain("main-only.ts")
      s.terminal.send("\t\r")
      await waitFor(() => userTexts(s.owned).includes("@design-only.ts"), "owned file reference")
      expect(userTexts(s.agent)).toEqual(["Main history"])
      s.terminal.send("\x1b[17~@main")
      await s.shows("main-only.ts")
      expect(s.live()).not.toContain("design-only.ts")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}
